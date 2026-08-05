'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../db');
const { requireTeacher } = require('../middleware');
const {
  newId, generateClassCode, signTeacherToken,
  isValidEmail, sanitize, COURSES, COURSE_PREFIXES,
  nowIso, toIso, isoFields, gradingPolicy,
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

    db.prepare("UPDATE teachers SET last_login = ?, last_seen = ? WHERE id = ?")
      .run(nowIso(), nowIso(), teacher.id);

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
  `).all(req.teacher.id).map(c => isoFields(c, ['created_at']));
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
  `).all(cls.id).map(s => isoFields(s, ['created_at', 'last_active']));

  res.json({ class: isoFields(cls, ['created_at']), students });
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
    SELECT student_id, unit, lesson, activity_type, completed, score, earned_points, max_points,
           attempts, confidence, completed_at
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
      // Present when the activity reported its own denominator. A consumer
      // should render "earned/max" when it has them and fall back to the
      // percentage otherwise, rather than assuming a scale of 100.
      earned_points: p.earned_points,
      max_points: p.max_points,
      // Same pair under the names the gradebook reads. It looks for
      // points_earned/points_possible, so emitting only the earned_points
      // spelling left it falling back to a hardcoded per-activity constant.
      points_earned: p.earned_points,
      points_possible: p.max_points,
      attempts: p.attempts,
      confidence: p.confidence,
      completed_at: toIso(p.completed_at),
    };
  }

  const courseConfig = COURSES[cls.course] || {};

  // Authored point totals per activity, keyed "lesson|activity" — the shape the
  // gradebook reads. Without it every column falls back to a per-activity
  // constant, which is how a lesson came to be displayed out of 100.
  //
  // Taken as the largest denominator any student reported for that activity:
  // students all sit the same assignment, so they agree, and MAX is immune to
  // a partially-saved attempt reporting a smaller total. Activities nobody has
  // point-scored are absent, which the client reads as "unknown", not zero.
  const denominators = {};
  for (const p of allProgress) {
    if (p.max_points == null || p.max_points <= 0) continue;
    const key = `${p.lesson}|${p.activity_type}`;
    denominators[key] = Math.max(denominators[key] || 0, p.max_points);
  }

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
      student: { id: s.id, name: s.display_name, ref: s.student_ref, last_active: toIso(s.last_active) },
      units: unitSummaries,
      detail: sp,
    };
  });

  res.json({
    class: isoFields(cls, ['created_at']),
    course_config: courseConfig,
    grading: gradingPolicy(cls),
    denominators,
    summary,
  });
});

// ── CSV EXPORT ────────────────────────────────────────────────────────────────
router.get('/classes/:code/export', requireTeacher, (req, res) => {
  const cls = db.prepare('SELECT * FROM classes WHERE class_code = ? AND teacher_id = ?')
    .get(req.params.code.toUpperCase(), req.teacher.id);
  if (!cls) return res.status(404).json({ error: 'Class not found' });

  const rows = db.prepare(`
    SELECT s.display_name, s.student_ref, s.last_active,
           p.unit, p.lesson, p.activity_type, p.completed, p.score, p.earned_points, p.max_points,
           p.attempts, p.confidence, p.completed_at
    FROM students s
    LEFT JOIN progress p ON p.student_id = s.id AND p.class_id = s.class_id
    WHERE s.class_id = ?
    ORDER BY s.display_name, p.unit, p.lesson, p.activity_type
  `).all(cls.id);

  const header = 'Name,Student ID,Unit,Lesson,Activity,Completed,Score,Earned,Possible,Attempts,Confidence,Completed At,Last Active\n';
  const lines = rows.map(r =>
    `"${r.display_name}","${r.student_ref || ''}","${r.unit || ''}","${r.lesson || ''}","${r.activity_type || ''}",` +
    `${r.completed ? 'Yes' : 'No'},${r.score ?? ''},${r.earned_points ?? ''},${r.max_points ?? ''},${r.attempts ?? ''},${r.confidence ?? ''},"${toIso(r.completed_at) || ''}","${toIso(r.last_active) || ''}"`
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

  const { class_name, active, mastery_threshold, grade_includes_lessons } = req.body;

  // Grading policy is stored per class rather than hardcoded in each front end,
  // so the teacher gradebook and the student dashboard cannot disagree about
  // what a grade means. Threshold is bounded to a range a percentage can be.
  let threshold = cls.mastery_threshold;
  if (mastery_threshold !== undefined) {
    const n = Number(mastery_threshold);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      return res.status(400).json({ error: 'mastery_threshold must be between 1 and 100' });
    }
    threshold = Math.round(n);
  }
  const includesLessons = grade_includes_lessons === undefined
    ? cls.grade_includes_lessons
    : (grade_includes_lessons ? 1 : 0);

  db.prepare(`
    UPDATE classes SET class_name = ?, active = ?, mastery_threshold = ?, grade_includes_lessons = ?
    WHERE id = ?
  `).run(
    sanitize(class_name || cls.class_name, 100),
    active !== undefined ? (active ? 1 : 0) : cls.active,
    threshold,
    includesLessons,
    cls.id
  );

  const updated = db.prepare('SELECT * FROM classes WHERE id = ?').get(cls.id);
  res.json({ class: isoFields(updated, ['created_at']), grading: gradingPolicy(updated) });
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
