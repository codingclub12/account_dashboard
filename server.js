'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://www.apcsexamprep.com',
  'https://apcsexamprep.com',
  'http://localhost:3000',
  'http://localhost:5173',
  'null', // file:// origin for local testing
];

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.use('/api/teacher', require('./routes/teacher'));
app.use('/api/student', require('./routes/student'));

// ── PUBLIC ENDPOINTS ──────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Validate class code exists (for student join flow)
app.get('/api/class/:code/exists', (req, res) => {
  const db = require('./db');
  const cls = db.prepare(`
    SELECT class_code, class_name, course,
      (SELECT COUNT(*) FROM students WHERE class_id = classes.id) as student_count
    FROM classes WHERE class_code = ? AND active = 1
  `).get(req.params.code.toUpperCase());
  if (!cls) return res.status(404).json({ exists: false });
  res.json({ exists: true, class_name: cls.class_name, course: cls.course, student_count: cls.student_count });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));

// ── ERROR HANDLER ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`APCSExamPrep Progress API running on port ${PORT}`);
  console.log(`DB: ${process.env.DB_PATH || './progress.db'}`);
});

module.exports = app;
