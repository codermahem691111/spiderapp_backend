const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  text: { type: String, required: true },
}, { timestamps: true });
module.exports = mongoose.model('Message', schema);
