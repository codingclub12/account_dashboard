'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../db');
const { requireStudent } = require('../middleware');
const { newId, signStudentToken, isValidPin, sanitize, COURSES } = require('../utils');

// ── JOIN CLASS (first time) ───────────────────────────────────────────────────
router.post('/join', async (req, res) => {
  try {
    const { class_code, display_name, pin } = req.body;
    if (!class_code) return res.status(400).json({ error: 'Class code required' });
    if (!display_name || display_name.trim().length < 1) return res.status(400).json({ error: 'Name required' });
    if (!isValidPin(pin)) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });

    const cls = db.prepare('SELECT * FROM classes WHERE class_code = ? AND active = 1')
      .get(class_code.toUpperCase().trim());
    if (!cls) return res.status(404).json({ error: 'Class not found or inactive. Check your class code.' });

    const cleanName = sanitize(display_name, 50);

    // Check if name already exists in this class
    const existing = db.prepare('SELECT id FROM students WHERE class_id = ? AND lower(display_name) = lower(?)').get(cls.id, cleanName);
    if (existing) return res.status(409).json({ error: 'That name is already taken in this class. Try adding your last initial, e.g. "Avery M."' });

    const pinHash = await bcrypt.hash(String(pin), 10);
    const id = newId();
    db.prepare(`
      INSERT INTO students (id, class_id, display_name, pin_hash)
      VALUES (?, ?, ?, ?)
    `).run(id, cls.id, cleanName, pinHash);

    const student = db.prepare('SELECT id, class_id, display_name FROM students WHERE id = ?').get(id);
    const token = signStudentToken(student, cls.class_code);

    res.status(201).json({
      token,
      student: { id: student.id, name: student.display_name },
      class: { code: cls.class_code, name: cls.class_name, course: cls.course },
    });
  } catch (e) {
    console.error('Join error:', e);
    res.status(500).json({ error: 'Failed to join class' });
  }
});

// ── LOGIN (returning student) ─────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { class_code, display_name, pin } = req.body;
    if (!class_code || !display_name || !pin) return res.status(400).json({ error: 'Class code, name, and PIN required' });

    const cls = db.prepare('SELECT * FROM classes WHERE class_code = ?').get(class_code.toUpperCase().trim());
    if (!cls) return res.status(404).json({ error: 'Class not found' });

    const student = db.prepare('SELECT * FROM students WHERE class_id = ? AND lower(display_name) = lower(?)')
      .get(cls.id, display_name.trim());
    if (!student) return res.status(401).json({ error: 'Name not found in this class' });

    const valid = await bcrypt.compare(String(pin), student.pin_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect PIN' });

    db.prepare("UPDATE students SET last_active = datetime('now') WHERE id = ?").run(student.id);
    const token = signStudentToken(student, cls.class_code);

    res.json({
      token,
      student: { id: student.id, name: student.display_name },
      class: { code: cls.class_code, name: cls.class_name, course: cls.course },
    });
  } catch (e) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── ME ────────────────────────────────────────────────────────────────────────
router.get('/me', requireStudent, (req, res) => {
  const cls = db.prepare('SELECT class_code, class_name, course FROM classes WHERE id = ?').get(req.student.class_id);
  res.json({ student: req.student, class: cls });
});

// ── GET ALL PROGRESS ──────────────────────────────────────────────────────────
router.get('/progress', requireStudent, (req, res) => {
  const records = db.prepare(`
    SELECT course, unit, lesson, activity_type, completed, score, attempts, confidence, completed_at, updated_at
    FROM progress WHERE student_id = ? ORDER BY unit, lesson, activity_type
  `).all(req.student.id);

  // Build structured map for easy frontend consumption
  const map = {};
  for (const r of records) {
    const key = `${r.course}|${r.unit}|${r.lesson}|${r.activity_type}`;
    map[key] = r;
  }

  res.json({ progress: records, map });
});

// ── SAVE / UPDATE PROGRESS ────────────────────────────────────────────────────
router.post('/progress', requireStudent, (req, res) => {
  try {
    const { course, unit, lesson, activity_type, completed, score, confidence, time_spent_s } = req.body;

    if (!course || !unit || !lesson || !activity_type) {
      return res.status(400).json({ error: 'course, unit, lesson, and activity_type required' });
    }

    const now = new Date().toISOString();
    const existing = db.prepare(`
      SELECT id, attempts FROM progress
      WHERE student_id = ? AND course = ? AND unit = ? AND lesson = ? AND activity_type = ?
    `).get(req.student.id, course, unit, lesson, activity_type);

    if (existing) {
      // Update existing record
      const newAttempts = (existing.attempts || 0) + (score != null ? 1 : 0);
      db.prepare(`
        UPDATE progress SET
          completed = CASE WHEN ? = 1 THEN 1 ELSE completed END,
          score = CASE WHEN ? IS NOT NULL THEN ? ELSE score END,
          attempts = ?,
          confidence = CASE WHEN ? IS NOT NULL THEN ? ELSE confidence END,
          time_spent_s = CASE WHEN ? IS NOT NULL THEN COALESCE(time_spent_s, 0) + ? ELSE time_spent_s END,
          completed_at = CASE WHEN ? = 1 AND completed_at IS NULL THEN ? ELSE completed_at END,
          updated_at = ?
        WHERE id = ?
      `).run(
        completed ? 1 : 0,
        score, score,
        newAttempts,
        confidence, confidence,
        time_spent_s, time_spent_s,
        completed ? 1 : 0, now,
        now,
        existing.id
      );
    } else {
      // Insert new record
      db.prepare(`
        INSERT INTO progress (id, student_id, class_id, course, unit, lesson, activity_type,
          completed, score, attempts, confidence, time_spent_s, completed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newId(), req.student.id, req.student.class_id,
        course, unit, lesson, activity_type,
        completed ? 1 : 0,
        score ?? null,
        score != null ? 1 : 0,
        confidence ?? null,
        time_spent_s ?? null,
        completed ? now : null,
        now
      );
    }

    const record = db.prepare(`
      SELECT * FROM progress
      WHERE student_id = ? AND course = ? AND unit = ? AND lesson = ? AND activity_type = ?
    `).get(req.student.id, course, unit, lesson, activity_type);

    res.json({ ok: true, progress: record });
  } catch (e) {
    console.error('Save progress error:', e);
    res.status(500).json({ error: 'Failed to save progress' });
  }
});

// ── SUBMIT QUIZ ATTEMPT ───────────────────────────────────────────────────────
router.post('/quiz', requireStudent, (req, res) => {
  try {
    const { course, unit, lesson, answers, score } = req.body;
    if (!course || !unit || !lesson) return res.status(400).json({ error: 'course, unit, lesson required' });
    if (typeof score !== 'number') return res.status(400).json({ error: 'score required (0-100)' });

    // Find or create progress record for quiz
    let progressRecord = db.prepare(`
      SELECT id FROM progress WHERE student_id = ? AND course = ? AND unit = ? AND lesson = ? AND activity_type = 'quiz'
    `).get(req.student.id, course, unit, lesson);

    const now = new Date().toISOString();
    const passed = score >= 60;

    if (!progressRecord) {
      const pid = newId();
      db.prepare(`
        INSERT INTO progress (id, student_id, class_id, course, unit, lesson, activity_type,
          completed, score, attempts, completed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'quiz', ?, ?, 1, ?, ?)
      `).run(pid, req.student.id, req.student.class_id, course, unit, lesson, passed ? 1 : 0, score, passed ? now : null, now);
      progressRecord = { id: pid };
    } else {
      db.prepare(`
        UPDATE progress SET
          score = CASE WHEN ? > COALESCE(score, 0) THEN ? ELSE score END,
          attempts = attempts + 1,
          completed = CASE WHEN ? >= 60 THEN 1 ELSE completed END,
          completed_at = CASE WHEN ? >= 60 AND completed_at IS NULL THEN ? ELSE completed_at END,
          updated_at = ?
        WHERE id = ?
      `).run(score, score, score, score, now, now, progressRecord.id);
    }

    // Log the attempt
    db.prepare(`
      INSERT INTO quiz_attempts (id, student_id, progress_id, course, unit, lesson, answers, score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(newId(), req.student.id, progressRecord.id, course, unit, lesson, JSON.stringify(answers || {}), score);

    res.json({ ok: true, score, passed });
  } catch (e) {
    console.error('Quiz submit error:', e);
    res.status(500).json({ error: 'Failed to submit quiz' });
  }
});

module.exports = router;
