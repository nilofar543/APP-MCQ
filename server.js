require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

mongoose
  .connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mcq_exam')
  .then(() => console.log('MongoDB connected'))
  .catch((e) => console.error('MongoDB error:', e.message));

/* ---------- Models ---------- */
const examSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    duration: { type: Number, default: 0 }, // minutes, 0 = no timer
    showAnswers: { type: Boolean, default: false }, // show correct answers after submit
    active: { type: Boolean, default: true },
    questions: [{ text: String, options: [String], correct: Number }],
  },
  { timestamps: true }
);
const Exam = mongoose.model('Exam', examSchema);

const submissionSchema = new mongoose.Schema(
  {
    exam: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', index: true },
    name: String,
    email: String,
    rollNo: String,
    answers: [Number], // -1 = not answered
    score: Number,
    total: Number,
    timeTaken: Number, // seconds
  },
  { timestamps: true }
);
submissionSchema.index({ exam: 1, email: 1 }, { unique: true }); // one attempt per email
const Submission = mongoose.model('Submission', submissionSchema);

/* ---------- Helpers ---------- */
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    if (e.name === 'CastError') return res.status(404).json({ error: 'Not found' });
    if (e.code === 11000) return res.status(409).json({ error: 'You have already submitted this exam.' });
    console.error(e);
    res.status(500).json({ error: e.message });
  });

const admin = (req, res, next) => {
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  if (req.headers['x-admin-password'] !== pw) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

const review = (exam, answers) =>
  exam.questions.map((q, i) => ({ text: q.text, options: q.options, correct: q.correct, chosen: answers[i] }));

/* ---------- Admin routes ---------- */
app.post('/api/admin/exams', admin, wrap(async (req, res) => {
  const { title, description, duration, showAnswers, questions } = req.body;
  if (!title || !Array.isArray(questions) || !questions.length)
    return res.status(400).json({ error: 'Title and at least one question are required.' });
  for (const q of questions) {
    if (!q.text || !Array.isArray(q.options) || q.options.length < 2 || q.options.some((o) => !o.trim()))
      return res.status(400).json({ error: 'Each question needs text and at least 2 filled options.' });
    if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.options.length)
      return res.status(400).json({ error: 'Each question needs a correct answer selected.' });
  }
  const exam = await Exam.create({ title, description, duration: Number(duration) || 0, showAnswers: !!showAnswers, questions });
  res.json({ id: exam._id });
}));

app.get('/api/admin/exams', admin, wrap(async (req, res) => {
  const exams = await Exam.find().sort({ createdAt: -1 }).lean();
  const counts = await Submission.aggregate([{ $group: { _id: '$exam', n: { $sum: 1 } } }]);
  const map = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  res.json(exams.map((e) => ({
    _id: e._id, title: e.title, active: e.active, duration: e.duration,
    questionCount: e.questions.length, submissions: map[String(e._id)] || 0, createdAt: e.createdAt,
  })));
}));

app.get('/api/admin/exams/:id/submissions', admin, wrap(async (req, res) => {
  const exam = await Exam.findById(req.params.id).lean();
  if (!exam) return res.status(404).json({ error: 'Not found' });
  const submissions = await Submission.find({ exam: exam._id }).sort({ createdAt: -1 }).lean();
  res.json({ exam: { title: exam.title, total: exam.questions.length }, submissions });
}));

app.get('/api/admin/exams/:id/export', admin, wrap(async (req, res) => {
  const exam = await Exam.findById(req.params.id).lean();
  if (!exam) return res.status(404).json({ error: 'Not found' });
  const subs = await Submission.find({ exam: exam._id }).sort({ createdAt: 1 }).lean();
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Name', 'Email', 'Roll No', 'Score', 'Total', 'Percentage', 'Time (sec)', 'Submitted At'].join(',')];
  subs.forEach((s) => rows.push([q(s.name), q(s.email), q(s.rollNo), s.score, s.total,
    ((s.score / s.total) * 100).toFixed(1) + '%', s.timeTaken ?? '', q(s.createdAt.toISOString())].join(',')));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="results.csv"');
  res.send(rows.join('\n'));
}));

app.patch('/api/admin/exams/:id/toggle', admin, wrap(async (req, res) => {
  const exam = await Exam.findById(req.params.id);
  if (!exam) return res.status(404).json({ error: 'Not found' });
  exam.active = !exam.active;
  await exam.save();
  res.json({ active: exam.active });
}));

app.delete('/api/admin/exams/:id', admin, wrap(async (req, res) => {
  await Exam.findByIdAndDelete(req.params.id);
  await Submission.deleteMany({ exam: req.params.id });
  res.json({ ok: true });
}));

/* ---------- Student routes ---------- */
app.get('/api/exams/:id', wrap(async (req, res) => {
  const exam = await Exam.findById(req.params.id).lean();
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (!exam.active) return res.status(403).json({ error: 'This exam is closed.' });
  res.json({
    title: exam.title, description: exam.description, duration: exam.duration,
    questions: exam.questions.map((q) => ({ text: q.text, options: q.options })), // no answers sent
  });
}));

app.post('/api/exams/:id/submit', wrap(async (req, res) => {
  const exam = await Exam.findById(req.params.id).lean();
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  if (!exam.active) return res.status(403).json({ error: 'This exam is closed.' });
  const { name, email, rollNo, answers, timeTaken } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
  const ans = exam.questions.map((_, i) => (Number.isInteger(answers?.[i]) ? answers[i] : -1));
  const score = exam.questions.reduce((s, q, i) => s + (ans[i] === q.correct ? 1 : 0), 0);
  await Submission.create({
    exam: exam._id, name: name.trim(), email: email.trim().toLowerCase(), rollNo: (rollNo || '').trim(),
    answers: ans, score, total: exam.questions.length, timeTaken: Number(timeTaken) || 0,
  });
  res.json({ score, total: exam.questions.length, review: exam.showAnswers ? review(exam, ans) : null });
}));

app.get('/api/exams/:id/result', wrap(async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  const exam = await Exam.findById(req.params.id).lean();
  const sub = exam && (await Submission.findOne({ exam: exam._id, email }).lean());
  if (!sub) return res.status(404).json({ error: 'No submission found for this email.' });
  res.json({ name: sub.name, score: sub.score, total: sub.total, review: exam.showAnswers ? review(exam, sub.answers) : null });
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}  (admin: /admin.html)`));
