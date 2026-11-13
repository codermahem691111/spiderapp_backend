const path = require('path');
require('dotenv').config();
require('dotenv').config({ path: path.join(__dirname, 'atlas-credentials.env') });
const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Server } = require('socket.io');
const User = require('./models/User');
const Message = require('./models/Message');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const UP = path.join(__dirname, 'uploads');
fs.mkdirSync(UP, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UP));

const upload = multer({
  storage: multer.diskStorage({
    destination: UP,
    filename: (_, f, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + path.extname(f.originalname || '.jpg')),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_, f, cb) => cb(null, /^image\//.test(f.mimetype)),
});

const online = new Map(); // userId -> Set(socketId)
const isOnline = (id) => online.has(String(id)) && online.get(String(id)).size > 0;
const pub = (u) => ({ _id: u._id, name: u.name, avatar: u.avatar });
const sign = (u) => jwt.sign({ id: u._id, name: u.name }, JWT_SECRET, { expiresIn: '30d' });

const auth = (req, res, next) => {
  try {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    req.user = jwt.verify(t, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
};

app.post('/api/register', upload.single('avatar'), async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password || password.length < 4) return res.status(400).json({ error: 'Name and password (min 4 chars) required' });
    if (await User.findOne({ nameLower: name.trim().toLowerCase() })) return res.status(409).json({ error: 'Name already taken' });
    const u = await User.create({
      name: name.trim(), nameLower: name.trim().toLowerCase(),
      password: await bcrypt.hash(password, 10),
      avatar: req.file ? '/uploads/' + req.file.filename : '',
    });
    res.json({ token: sign(u), user: pub(u) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { name, password } = req.body;
    const u = await User.findOne({ nameLower: (name || '').trim().toLowerCase() });
    if (!u || !(await bcrypt.compare(password || '', u.password))) return res.status(401).json({ error: 'Invalid name or password' });
    res.json({ token: sign(u), user: pub(u) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', auth, async (req, res) => {
  const u = await User.findById(req.user.id);
  res.json(pub(u));
});

app.put('/api/profile', auth, upload.single('avatar'), async (req, res) => {
  try {
    const u = await User.findById(req.user.id);
    if (req.file) u.avatar = '/uploads/' + req.file.filename;
    await u.save();
    res.json(pub(u));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users', auth, async (req, res) => {
  const list = await User.find({ _id: { $ne: req.user.id } }).sort({ name: 1 });
  res.json(list.map((u) => ({ ...pub(u), online: isOnline(u._id) })));
});

app.get('/api/messages/:id', auth, async (req, res) => {
  const me = req.user.id, other = req.params.id;
  const msgs = await Message.find({ $or: [{ from: me, to: other }, { from: other, to: me }] }).sort({ createdAt: 1 }).limit(500);
  res.json(msgs);
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.use((socket, next) => {
  try { socket.user = jwt.verify(socket.handshake.auth.token, JWT_SECRET); next(); }
  catch { next(new Error('unauthorized')); }
});

const emitTo = (id, ev, data) => (online.get(String(id)) || new Set()).forEach((sid) => io.to(sid).emit(ev, data));

io.on('connection', (socket) => {
  const uid = String(socket.user.id);
  if (!online.has(uid)) online.set(uid, new Set());
  online.get(uid).add(socket.id);
  io.emit('presence', { userId: uid, online: true });

  socket.on('message:send', async ({ to, text }, ack) => {
    if (!to || !text || !text.trim()) return;
    const m = await Message.create({ from: uid, to, text: text.trim() });
    emitTo(to, 'message:new', m);
    emitTo(uid, 'message:new', m);
    ack && ack(m);
  });

  // ---- WebRTC signaling ----
  socket.on('call:offer', ({ to, offer, video }) => emitTo(to, 'call:incoming', { from: uid, fromName: socket.user.name, offer, video }));
  socket.on('call:answer', ({ to, answer }) => emitTo(to, 'call:answered', { from: uid, answer }));
  socket.on('call:ice', ({ to, candidate }) => emitTo(to, 'call:ice', { from: uid, candidate }));
  socket.on('call:end', ({ to }) => emitTo(to, 'call:ended', { from: uid }));
  socket.on('call:reject', ({ to }) => emitTo(to, 'call:ended', { from: uid }));

  socket.on('disconnect', () => {
    const s = online.get(uid);
    if (s) { s.delete(socket.id); if (!s.size) { online.delete(uid); io.emit('presence', { userId: uid, online: false }); } }
  });
});

mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/spider')
  .then(() => server.listen(process.env.PORT || 5000, '0.0.0.0', () => console.log('Spider server on :' + (process.env.PORT || 5000))))
  .catch((e) => { console.error('Mongo error', e.message); process.exit(1); });
