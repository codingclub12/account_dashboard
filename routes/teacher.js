'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../db');
const { requireTeacher } = require('../middleware');
const {
  newId, generateClassCode, signTeacherToken,
  isValidEmail, sanitize, COURSES, COURSE_PREFIXES,
} = require('../utils');

// ── REGISTER ──────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, school } = req.body;
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Name required' });

    const existing = db.prepare('SELECT id FROM teachers WHERE email = ?').get(email.trim().toLowerCase());
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 12);
    const id = newId();
    db.prepare(`
      INSERT INTO teachers (id, email, name, school, password_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, email.trim().toLowerCase(), sanitize(name, 100), sanitize(school || '', 200), hash);

    const teacher = db.prepare('SELECT id, email, name, school FROM teachers WHERE id = ?').get(id);
    const token = signTeacherToken(teacher);
    res.status(201).json({ token, teacher: { id: teacher.id, email: teacher.email, name: teacher.name, school: teacher.school } });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── LOGIN ─────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const teacher = db.prepare('SELECT * FROM teachers WHERE email = ?').get(email.trim().toLowerCase());
    if (!teacher) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, teacher.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = signTeacherToken(teacher);
    res.json({ token, teacher: { id: teacher.id, email: teacher.email, name: teacher.name, school: teacher.school } });
  } catch (e) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── ME ────────────────────────────────────────────────────────────────────────
router.get('/me', requireTeacher, (req, res) => {
  res.json({ teacher: req.teacher });
});

// ── LIST CLASSES ──────────────────────────────────────────────────────────────
router.get('/classes', requireTeacher, (req, res) => {
  const classes = db.prepare(`
    SELECT c.*, 
      (SELECT COUNT(*) FROM students WHERE class_id = c.id) as student_count,
      (SELECT COUNT(*) FROM progress WHERE class_id = c.id AND completed = 1) as completions
    FROM classes c
    WHERE c.teacher_id = ?
    ORDER BY c.created_at DESC
  `).all(req.teacher.id);
  res.json({ classes });
});

// ── CREATE CLASS ──────────────────────────────────────────────────────────────
router.post('/classes', requireTeacher, (req, res) => {
  try {
    const { class_name, course = 'ap-cybersecurity' } = req.body;
    if (!class_name || class_name.trim().length < 2) return res.status(400).json({ error: 'Class name required' });
    if (!COURSES[course]) return res.status(400).json({ error: 'Invalid course' });

    const prefix = COURSE_PREFIXES[course] || 'CLASS';
    // Generate unique class code
    let code, attempts = 0;
    do {
      code = generateClassCode(prefix);
      attempts++;
      if (attempts > 20) return res.status(500).json({ error: 'Could not generate unique class code' });
    } while (db.prepare('SELECT id FROM classes WHERE class_code = ?').get(code));

    const id = newId();
    db.prepare(`
      INSERT INTO classes (id, teacher_id, class_code, class_name, course)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.teacher.id, code, sanitize(class_name, 100), course);

    const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
    res.status(201).json({ class: cls });
  } catch (e) {
    console.error('Create class error:', e);
    res.status(500).json({ error: 'Failed to create class' });
  }
});

// ── GET CLASS DETAILS ─────────────────────────────────────────────────────────
router.get('/classes/:code', requireTeacher, (req, res) => {
  const cls = db.prepare('SELECT * FROM classes WHERE class_code = ? AND teacher_id = ?')
    .get(req.params.code.toUpperCase(), req.teacher.id);
  if (!cls) return res.status(404).json({ error: 'Class not found' });

  const students = db.prepare(`
    SELECT id, display_name, student_ref, created_at, last_active
    FROM students WHERE class_id = ? ORDER BY display_name
  `).all(cls.id);

  res.json({ class: cls, students });
});

// ── CLASS PROGRESS DASHBOARD ──────────────────────────────────────────────────
router.get('/classes/:code/progress', requireTeacher, (req, res) => {
  const cls = db.prepare('SELECT * FROM classes WHERE class_code = ? AND teacher_id = ?')
    .get(req.params.code.toUpperCase(), req.teacher.id);
  if (!cls) return res.status(404).json({ error: 'Class not found' });

  const students = db.prepare(`
    SELECT id, display_name, student_ref, last_active
    FROM students WHERE class_id = ? ORDER BY display_name
  `).all(cls.id);

  const allProgress = db.prepare(`
    SELECT student_id, unit, lesson, activity_type, completed, score, attempts, confidence, completed_at
    FROM progress WHERE class_id = ? AND course = ?
  `).all(cls.id, cls.course);

  // Build progress map: student_id → { unit → { lesson → { activity → record } } }
  const progressMap = {};
  for (const p of allProgress) {
    if (!progressMap[p.student_id]) progressMap[p.student_id] = {};
    if (!progressMap[p.student_id][p.unit]) progressMap[p.student_id][p.unit] = {};
    if (!progressMap[p.student_id][p.unit][p.lesson]) progressMap[p.student_id][p.unit][p.lesson] = {};
    progressMap[p.student_id][p.unit][p.lesson][p.activity_type] = {
      completed: !!p.completed,
      score: p.score,
      attempts: p.attempts,
      confidence: p.confidence,
      completed_at: p.completed_at,
    };
  }

  const courseConfig = COURSES[cls.course] || {};

  // Compute per-student summary
  const summary = students.map(s => {
    const sp = progressMap[s.id] || {};
    const unitSummaries = {};
    for (const [unitKey, unitCfg] of Object.entries(courseConfig.units || {})) {
      let totalActivities = 0, completedActivities = 0, totalScore = 0, scoredCount = 0;
      for (const lesson of unitCfg.lessons) {
        for (const act of unitCfg.activities) {
          totalActivities++;
          const rec = sp[unitKey]?.[lesson]?.[act];
          if (rec?.completed) completedActivities++;
          if (rec?.score != null) { totalScore += rec.score; scoredCount++; }
        }
      }
      unitSummaries[unitKey] = {
        completed: completedActivities,
        total: totalActivities,
        pct: totalActivities ? Math.round(completedActivities / totalActivities * 100) : 0,
        avg_score: scoredCount ? Math.round(totalScore / scoredCount) : null,
      };
    }
    return {
      student: { id: s.id, name: s.display_name, ref: s.student_ref, last_active: s.last_active },
      units: unitSummaries,
      detail: sp,
    };
  });

  res.json({ class: cls, course_config: courseConfig, summary });
});

// ── CSV EXPORT ────────────────────────────────────────────────────────────────
router.get('/classes/:code/export', requireTeacher, (req, res) => {
  const cls = db.prepare('SELECT * FROM classes WHERE class_code = ? AND teacher_id = ?')
    .get(req.params.code.toUpperCase(), req.teacher.id);
  if (!cls) return res.status(404).json({ error: 'Class not found' });

  const rows = db.prepare(`
    SELECT s.display_name, s.student_ref, s.last_active,
           p.unit, p.lesson, p.activity_type, p.completed, p.score, p.attempts, p.confidence, p.completed_at
    FROM students s
    LEFT JOIN progress p ON p.student_id = s.id AND p.class_id = s.class_id
    WHERE s.class_id = ?
    ORDER BY s.display_name, p.unit, p.lesson, p.activity_type
  `).all(cls.id);

  const header = 'Name,Student ID,Unit,Lesson,Activity,Completed,Score,Attempts,Confidence,Completed At,Last Active\n';
  const lines = rows.map(r =>
    `"${r.display_name}","${r.student_ref || ''}","${r.unit || ''}","${r.lesson || ''}","${r.activity_type || ''}",` +
    `${r.completed ? 'Yes' : 'No'},${r.score ?? ''},${r.attempts ?? ''},${r.confidence ?? ''},"${r.completed_at || ''}","${r.last_active || ''}"`
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${cls.class_code}-progress.csv"`);
  res.send(header + lines);
});

// ── UPDATE CLASS ──────────────────────────────────────────────────────────────
router.put('/classes/:code', requireTeacher, (req, res) => {
  const cls = db.prepare('SELECT * FROM classes WHERE class_code = ? AND teacher_id = ?')
    .get(req.params.code.toUpperCase(), req.teacher.id);
  if (!cls) return res.status(404).json({ error: 'Class not found' });

  const { class_name, active } = req.body;
  db.prepare('UPDATE classes SET class_name = ?, active = ? WHERE id = ?')
    .run(sanitize(class_name || cls.class_name, 100), active !== undefined ? (active ? 1 : 0) : cls.active, cls.id);

  res.json({ class: db.prepare('SELECT * FROM classes WHERE id = ?').get(cls.id) });
});

// ── REMOVE STUDENT ─────────────────────────────────────────────────────────────
router.delete('/classes/:code/students/:studentId', requireTeacher, (req, res) => {
  const cls = db.prepare('SELECT id FROM classes WHERE class_code = ? AND teacher_id = ?')
    .get(req.params.code.toUpperCase(), req.teacher.id);
  if (!cls) return res.status(404).json({ error: 'Class not found' });

  db.prepare('DELETE FROM students WHERE id = ? AND class_id = ?').run(req.params.studentId, cls.id);
  res.json({ ok: true });
});

module.exports = router;
