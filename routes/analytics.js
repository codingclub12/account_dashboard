'use strict';
/**
 * Cross-tenant analytics export.
 *
 * Every endpoint here reads across all teachers and classes, so it sits behind
 * ADMIN_TOKEN rather than teacher auth, and it emits hashed identifiers only —
 * no names, no email addresses, no class codes. Class codes are live join
 * credentials, so they are as sensitive as a password and never leave here.
 *
 * A note on precision. `progress` rows are updated in place and
 * `students.last_active` is overwritten, so the only append-only record of
 * activity is `quiz_attempts`. Anything below that counts distinct active days
 * is therefore a floor, not an exact figure; those fields are suffixed
 * `_min` and the caveat is repeated in /summary.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../middleware');

const PASS_SCORE = 60; // matches routes/student.js quiz grading

router.use(requireAdmin);

// ── IDENTIFIER HASHING ────────────────────────────────────────────────────────
// Stable across exports (so rows can be joined between two downloads) but not
// reversible to a student, teacher, or class without the salt.
const SALT = process.env.ANALYTICS_SALT || process.env.JWT_SECRET || 'dev-salt';
function hashId(prefix, id) {
  if (!id) return '';
  return prefix + '_' + crypto.createHash('sha256').update(SALT + ':' + id).digest('hex').slice(0, 16);
}

// ── DATES ─────────────────────────────────────────────────────────────────────
// Timestamps in this database come from two sources with different shapes:
// SQLite's datetime('now') gives "YYYY-MM-DD HH:MM:SS" while JS toISOString()
// gives "YYYY-MM-DDTHH:MM:SS.sssZ". Both are UTC and both start with the same
// 10-character date, so all day bucketing works off substr(ts, 1, 10).
function today() { return new Date().toISOString().slice(0, 10); }

function shiftDay(day, delta) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000);
}

// Resolves ?days=30 or ?from=&to= into an explicit, always-populated range.
// The previous export reported "range: { days: 0 }" because no range was ever
// applied; here the range is always concrete and echoed back with the data.
function parseRange(query) {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : today();
  let from;
  if (/^\d{4}-\d{2}-\d{2}$/.test(query.from || '')) {
    from = query.from;
  } else {
    const days = Math.max(1, Math.min(3650, parseInt(query.days, 10) || 30));
    from = shiftDay(to, -(days - 1));
  }
  return { from, to, days: daysBetween(from, to) + 1 };
}

// ── OUTPUT ────────────────────────────────────────────────────────────────────
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csvBody(columns, rows) {
  return [columns.join(',')]
    .concat(rows.map(r => columns.map(c => csvCell(r[c])).join(',')))
    .join('\n');
}

// Every tabular endpoint accepts ?format=csv and otherwise returns JSON.
function send(req, res, name, columns, rows, extra) {
  if ((req.query.format || '').toLowerCase() === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    return res.send(csvBody(columns, rows));
  }
  res.json(Object.assign({ columns, rows }, extra || {}));
}

// ── ACTIVITY CLASSIFICATION ───────────────────────────────────────────────────
// activity_type is free text set by the page, so the export has to bucket it.
// Known shapes: lesson, exercise-1, exercise-2, quiz, cfu-3, lab-1, exam.
function activityCategory(activityType) {
  const t = String(activityType || '').toLowerCase();
  if (t.startsWith('cfu')) return 'cfu';
  if (t.startsWith('quiz')) return 'quiz';
  if (t.startsWith('exercise')) return 'exercise';
  if (t.startsWith('lab')) return 'lab';
  if (t.startsWith('exam')) return 'exam';
  if (t.startsWith('lesson')) return 'lesson';
  return 'other';
}

// ── ACTIVE DAYS ───────────────────────────────────────────────────────────────
// Builds student_id → Set of 'YYYY-MM-DD' the student did something. Assembled
// from every timestamp the schema retains; see the file header for why this is
// a lower bound.
function activeDaysByStudent() {
  const rows = db.prepare(`
    SELECT student_id, substr(opened_at, 1, 10) AS day FROM progress WHERE opened_at IS NOT NULL
    UNION
    SELECT student_id, substr(completed_at, 1, 10) FROM progress WHERE completed_at IS NOT NULL
    UNION
    SELECT student_id, substr(updated_at, 1, 10) FROM progress WHERE updated_at IS NOT NULL
    UNION
    SELECT student_id, substr(attempted_at, 1, 10) FROM quiz_attempts WHERE attempted_at IS NOT NULL
    UNION
    SELECT id, substr(last_active, 1, 10) FROM students WHERE last_active IS NOT NULL
  `).all();

  const map = new Map();
  for (const r of rows) {
    if (!r.day) continue;
    if (!map.has(r.student_id)) map.set(r.student_id, new Set());
    map.get(r.student_id).add(r.day);
  }
  return map;
}

// ── STUDENT-LEVEL TABLE ───────────────────────────────────────────────────────
// One row per student, no names. This is the table that makes classroom
// retention measurable directly instead of inferred from traffic analytics.
const STUDENT_COLUMNS = [
  'student_id', 'class_id', 'teacher_id', 'course',
  'enrolled_at', 'first_activity_at', 'last_seen_at',
  'active_days_min', 'activities_opened', 'activities_completed',
  'graded_attempted', 'graded_passed', 'quiz_attempts', 'active_minutes',
];

function studentRows() {
  const students = db.prepare(`
    SELECT
      s.id, s.class_id, s.created_at AS enrolled_at, s.last_active,
      c.teacher_id, c.course,
      (SELECT COUNT(*) FROM progress p WHERE p.student_id = s.id) AS activities_opened,
      (SELECT COUNT(*) FROM progress p WHERE p.student_id = s.id AND p.completed = 1) AS activities_completed,
      (SELECT COUNT(*) FROM progress p WHERE p.student_id = s.id AND p.score IS NOT NULL) AS graded_attempted,
      (SELECT COUNT(*) FROM progress p WHERE p.student_id = s.id AND p.score >= ${PASS_SCORE}) AS graded_passed,
      (SELECT COUNT(*) FROM quiz_attempts q WHERE q.student_id = s.id) AS quiz_attempts,
      (SELECT COALESCE(SUM(p.time_spent_s), 0) FROM progress p WHERE p.student_id = s.id) AS time_spent_s,
      (SELECT MIN(COALESCE(p.opened_at, p.updated_at)) FROM progress p WHERE p.student_id = s.id) AS first_progress_at,
      (SELECT MAX(p.updated_at) FROM progress p WHERE p.student_id = s.id) AS last_progress_at
    FROM students s
    JOIN classes c ON c.id = s.class_id
    ORDER BY s.created_at
  `).all();

  const activeDays = activeDaysByStudent();

  return students.map(s => {
    const days = activeDays.get(s.id) || new Set();
    // first_activity_at is deliberately not backfilled from enrolled_at: a
    // student who joined and never opened anything should read as null here,
    // matching active_days_min = 0.
    const lasts = [s.last_active, s.last_progress_at].filter(Boolean).sort();
    return {
      student_id: hashId('stu', s.id),
      class_id: hashId('cls', s.class_id),
      teacher_id: hashId('tch', s.teacher_id),
      course: s.course,
      enrolled_at: s.enrolled_at,
      first_activity_at: s.first_progress_at || null,
      last_seen_at: lasts[lasts.length - 1] || null,
      active_days_min: days.size,
      activities_opened: s.activities_opened,
      activities_completed: s.activities_completed,
      graded_attempted: s.graded_attempted,
      graded_passed: s.graded_passed,
      quiz_attempts: s.quiz_attempts,
      active_minutes: Math.round((s.time_spent_s || 0) / 60),
    };
  });
}

router.get('/students', (req, res) => {
  send(req, res, 'students', STUDENT_COLUMNS, studentRows());
});

// ── CLASS × DAY ACTIVITY ──────────────────────────────────────────────────────
// Answers "is this class set up, piloting, activated, or fading out?" without
// having to eyeball per-student rows.
const CLASS_DAY_COLUMNS = [
  'date', 'class_id', 'teacher_id', 'course',
  'roster', 'active_students', 'completions', 'graded_attempts', 'graded_passes', 'active_minutes',
];

function classDayRows(range) {
  const classes = db.prepare('SELECT id, teacher_id, course FROM classes').all();
  const classById = new Map(classes.map(c => [c.id, c]));

  // Roster is as-of each day: students who had joined by then.
  const enrollments = db.prepare('SELECT class_id, substr(created_at, 1, 10) AS day FROM students').all();

  const progressDays = db.prepare(`
    SELECT class_id, student_id,
           substr(COALESCE(completed_at, updated_at), 1, 10) AS day,
           completed, score, COALESCE(time_spent_s, 0) AS time_spent_s
    FROM progress
    WHERE substr(COALESCE(completed_at, updated_at), 1, 10) BETWEEN ? AND ?
  `).all(range.from, range.to);

  const quizDays = db.prepare(`
    SELECT s.class_id, q.student_id, substr(q.attempted_at, 1, 10) AS day, q.score
    FROM quiz_attempts q
    JOIN students s ON s.id = q.student_id
    WHERE substr(q.attempted_at, 1, 10) BETWEEN ? AND ?
  `).all(range.from, range.to);

  const cells = new Map(); // "day|class_id" → accumulator
  function cell(day, classId) {
    const key = day + '|' + classId;
    if (!cells.has(key)) {
      cells.set(key, {
        day, classId, students: new Set(),
        completions: 0, attempts: 0, passes: 0, seconds: 0,
      });
    }
    return cells.get(key);
  }

  for (const p of progressDays) {
    if (!p.day || !classById.has(p.class_id)) continue;
    const c = cell(p.day, p.class_id);
    c.students.add(p.student_id);
    if (p.completed) c.completions++;
    if (p.score !== null) { c.attempts++; if (p.score >= PASS_SCORE) c.passes++; }
    c.seconds += p.time_spent_s;
  }
  for (const q of quizDays) {
    if (!q.day || !classById.has(q.class_id)) continue;
    const c = cell(q.day, q.class_id);
    c.students.add(q.student_id);
  }

  return Array.from(cells.values())
    .sort((a, b) => (a.day === b.day ? a.classId.localeCompare(b.classId) : a.day.localeCompare(b.day)))
    .map(c => {
      const cls = classById.get(c.classId);
      const roster = enrollments.filter(e => e.class_id === c.classId && e.day <= c.day).length;
      return {
        date: c.day,
        class_id: hashId('cls', c.classId),
        teacher_id: hashId('tch', cls.teacher_id),
        course: cls.course,
        roster,
        active_students: c.students.size,
        completions: c.completions,
        graded_attempts: c.attempts,
        graded_passes: c.passes,
        active_minutes: Math.round(c.seconds / 60),
      };
    });
}

router.get('/class-days', (req, res) => {
  const range = parseRange(req.query);
  send(req, res, 'class-days', CLASS_DAY_COLUMNS, classDayRows(range), { range });
});

// ── TEACHER ADOPTION FUNNEL ───────────────────────────────────────────────────
// Shows the step at which each teacher stopped, which raw class and student
// counts cannot.
const FUNNEL_STEPS = [
  'registered',
  'created_a_class',
  'first_student_joined',
  'ten_students_joined',
  'first_lesson_completion',
  'first_graded_attempt',
  'returned_after_week_1',
];

function teacherFunnelRows() {
  const teachers = db.prepare(`
    SELECT
      t.id, t.created_at, t.last_login, t.last_seen,
      (SELECT COUNT(*) FROM classes c WHERE c.teacher_id = t.id) AS classes,
      (SELECT COUNT(*) FROM students s JOIN classes c ON c.id = s.class_id WHERE c.teacher_id = t.id) AS students,
      (SELECT COUNT(*) FROM progress p JOIN classes c ON c.id = p.class_id
         WHERE c.teacher_id = t.id AND p.completed = 1) AS completions,
      (SELECT COUNT(*) FROM progress p JOIN classes c ON c.id = p.class_id
         WHERE c.teacher_id = t.id AND p.score IS NOT NULL) AS graded,
      (SELECT MAX(students_in_class) FROM (
         SELECT COUNT(s.id) AS students_in_class FROM classes c2
         LEFT JOIN students s ON s.class_id = c2.id
         WHERE c2.teacher_id = t.id GROUP BY c2.id
       )) AS biggest_class
    FROM teachers t
    ORDER BY t.created_at
  `).all();

  return teachers.map(t => {
    const reached = {
      registered: true,
      created_a_class: t.classes > 0,
      first_student_joined: t.students > 0,
      ten_students_joined: (t.biggest_class || 0) >= 10,
      first_lesson_completion: t.completions > 0,
      first_graded_attempt: t.graded > 0,
      // Only measurable for teachers who have logged in since last_seen shipped.
      // null means "not yet knowable", which is different from false.
      returned_after_week_1: t.last_seen
        ? daysBetween(t.created_at.slice(0, 10), t.last_seen.slice(0, 10)) >= 7
        : null,
    };

    // Walk the steps in order and stop at the first one not reached, so
    // furthest_step means "got this far" rather than "hit this at some point".
    // A teacher can reach first_lesson_completion with a 4-student class, so a
    // later step being true does not imply the earlier ones are.
    let furthestIdx = -1;
    for (const step of FUNNEL_STEPS) {
      if (reached[step] !== true) break;
      furthestIdx++;
    }
    const stalledIdx = furthestIdx + 1;

    return {
      teacher_id: hashId('tch', t.id),
      registered_at: t.created_at,
      last_login: t.last_login || null,
      last_seen: t.last_seen || null,
      classes: t.classes,
      students: t.students,
      biggest_class: t.biggest_class || 0,
      completions: t.completions,
      graded_attempts: t.graded,
      furthest_step: FUNNEL_STEPS[Math.max(0, furthestIdx)],
      stalled_at: stalledIdx < FUNNEL_STEPS.length ? FUNNEL_STEPS[stalledIdx] : null,
      // Every step, so a class that produced work without reaching ten students
      // is still visible rather than collapsed into furthest_step.
      reached,
    };
  });
}

// Each step is counted from its own boolean rather than derived from
// furthest_step. The result is intentionally not forced monotonic — teachers
// really do get completions from classes smaller than ten.
function teacherFunnelSummary(rows) {
  const total = rows.length;
  return FUNNEL_STEPS.map(step => {
    const teachers = rows.filter(r => r.reached[step] === true).length;
    // null means the answer isn't knowable yet (no last_seen recorded before
    // this shipped), which is different from the teacher not returning.
    const measurable = rows.filter(r => r.reached[step] !== null).length;
    return {
      step,
      teachers,
      measurable,
      pct_of_registered: total ? Math.round((teachers / total) * 100) : 0,
      stalled_here: rows.filter(r => r.stalled_at === step).length,
    };
  });
}

router.get('/teacher-funnel', (req, res) => {
  const rows = teacherFunnelRows();
  if ((req.query.format || '').toLowerCase() === 'csv') {
    const columns = ['teacher_id', 'registered_at', 'last_login', 'last_seen', 'classes', 'students',
      'biggest_class', 'completions', 'graded_attempts', 'furthest_step', 'stalled_at']
      .concat(FUNNEL_STEPS.map(s => 'reached_' + s));
    const flat = rows.map(r => Object.assign({}, r, ...FUNNEL_STEPS.map(s => ({
      // Empty rather than "null" so spreadsheets show unknown as blank.
      ['reached_' + s]: r.reached[s] === null ? '' : (r.reached[s] ? 'yes' : 'no'),
    }))));
    return send(req, res, 'teacher-funnel', columns, flat);
  }
  res.json({ summary: teacherFunnelSummary(rows), teachers: rows });
});

// ── ASSESSMENT BREAKDOWN ──────────────────────────────────────────────────────
// The old export collapsed every graded activity into one "attempted a graded
// item" number, which hid the fact that CFUs, quizzes, and exercises have very
// different participation.
const ASSESSMENT_COLUMNS = [
  'course', 'category', 'students', 'records', 'attempted', 'passed', 'pass_rate_pct', 'avg_score_pct', 'active_minutes',
];

function assessmentRows() {
  const rows = db.prepare(`
    SELECT course, activity_type, student_id, score, COALESCE(time_spent_s, 0) AS time_spent_s
    FROM progress
  `).all();

  const buckets = new Map();
  for (const r of rows) {
    const key = r.course + '|' + activityCategory(r.activity_type);
    if (!buckets.has(key)) {
      buckets.set(key, {
        course: r.course, category: activityCategory(r.activity_type),
        students: new Set(), records: 0, attempted: 0, passed: 0, scoreSum: 0, seconds: 0,
      });
    }
    const b = buckets.get(key);
    b.students.add(r.student_id);
    b.records++;
    b.seconds += r.time_spent_s;
    if (r.score !== null) {
      b.attempted++;
      b.scoreSum += r.score;
      if (r.score >= PASS_SCORE) b.passed++;
    }
  }

  return Array.from(buckets.values())
    .sort((a, b) => (a.course === b.course ? b.records - a.records : a.course.localeCompare(b.course)))
    .map(b => ({
      course: b.course,
      category: b.category,
      students: b.students.size,
      records: b.records,
      attempted: b.attempted,
      passed: b.passed,
      pass_rate_pct: b.attempted ? Math.round((b.passed / b.attempted) * 100) : null,
      avg_score_pct: b.attempted ? Math.round(b.scoreSum / b.attempted) : null,
      active_minutes: Math.round(b.seconds / 60),
    }));
}

router.get('/assessment', (req, res) => {
  send(req, res, 'assessment', ASSESSMENT_COLUMNS, assessmentRows());
});

// ── CORRECTED FUNNEL ──────────────────────────────────────────────────────────
// "Opened" and "Completed" are now separate stages. Before the tracker fix they
// were the same event, so completions recorded before COMPLETION_FIX_DATE still
// mean "opened the page" — the response says so rather than quietly mixing them.
function funnelRows() {
  const enrolled = db.prepare('SELECT COUNT(*) AS n FROM students').get().n;
  const opened = db.prepare('SELECT COUNT(DISTINCT student_id) AS n FROM progress').get().n;
  const completed = db.prepare('SELECT COUNT(DISTINCT student_id) AS n FROM progress WHERE completed = 1').get().n;
  const attempted = db.prepare(`
    SELECT COUNT(DISTINCT student_id) AS n FROM (
      SELECT student_id FROM progress WHERE score IS NOT NULL
      UNION SELECT student_id FROM quiz_attempts
    )
  `).get().n;
  const passed = db.prepare(`
    SELECT COUNT(DISTINCT student_id) AS n FROM (
      SELECT student_id FROM progress WHERE score >= ${PASS_SCORE}
      UNION SELECT student_id FROM quiz_attempts WHERE score >= ${PASS_SCORE}
    )
  `).get().n;

  const stages = [
    ['Enrolled', enrolled],
    ['Opened an activity', opened],
    ['Completed an activity', completed],
    ['Attempted a graded item', attempted],
    ['Passed a graded item', passed],
  ];
  return stages.map(([stage, students]) => ({
    stage,
    students,
    pct_of_top: enrolled ? Math.round((students / enrolled) * 100) : 0,
  }));
}

function completionCaveat() {
  const fixDate = process.env.COMPLETION_FIX_DATE || null;
  if (!fixDate) {
    return {
      trustworthy: false,
      note: 'Completions recorded before the engagement-threshold tracker shipped mean ' +
            '"opened the page". Set COMPLETION_FIX_DATE=YYYY-MM-DD to the deploy date to split them out.',
    };
  }
  const before = db.prepare(
    'SELECT COUNT(*) AS n FROM progress WHERE completed = 1 AND substr(COALESCE(completed_at, updated_at), 1, 10) < ?'
  ).get(fixDate).n;
  const after = db.prepare(
    'SELECT COUNT(*) AS n FROM progress WHERE completed = 1 AND substr(COALESCE(completed_at, updated_at), 1, 10) >= ?'
  ).get(fixDate).n;
  return {
    trustworthy: true,
    fix_date: fixDate,
    completions_before_fix: before,
    completions_after_fix: after,
    note: 'completions_before_fix were recorded on page load and mean "opened", not "completed".',
  };
}

router.get('/funnel', (req, res) => {
  res.json({ stages: funnelRows(), completion_semantics: completionCaveat() });
});

// ── RETENTION ─────────────────────────────────────────────────────────────────
// Rates only count students whose window has fully elapsed; a student who
// enrolled yesterday cannot yet have failed day-7 retention.
function retentionSummary() {
  const students = db.prepare('SELECT id, substr(created_at, 1, 10) AS enrolled_day FROM students').all();
  const activeDays = activeDaysByStudent();
  const now = today();

  const windows = [
    { key: 'day_1',  from: 1, to: 1 },
    { key: 'day_7',  from: 1, to: 7 },
    { key: 'week_2', from: 8, to: 14 },
  ];

  const out = windows.map(w => {
    let eligible = 0, retained = 0;
    for (const s of students) {
      if (!s.enrolled_day) continue;
      // Window must have closed for this student to count either way.
      if (daysBetween(s.enrolled_day, now) < w.to) continue;
      eligible++;
      const days = activeDays.get(s.id);
      if (!days) continue;
      for (let d = w.from; d <= w.to; d++) {
        if (days.has(shiftDay(s.enrolled_day, d))) { retained++; break; }
      }
    }
    return { window: w.key, eligible, retained, rate_pct: eligible ? Math.round((retained / eligible) * 100) : null };
  });

  const multiDay = students.filter(s => (activeDays.get(s.id) || new Set()).size >= 2).length;
  out.push({
    window: 'two_or_more_active_days',
    eligible: students.length,
    retained: multiDay,
    rate_pct: students.length ? Math.round((multiDay / students.length) * 100) : null,
  });

  return out;
}

router.get('/retention', (req, res) => {
  res.json({
    windows: retentionSummary(),
    caveat: 'Active days are reconstructed from retained timestamps. progress rows are ' +
            'updated in place, so these counts are a lower bound.',
  });
});

// ── COMBINED EXPORT ───────────────────────────────────────────────────────────
router.get('/summary', (req, res) => {
  const range = parseRange(req.query);
  const teachers = teacherFunnelRows();
  res.json({
    generated_at: new Date().toISOString(),
    range,
    funnel: funnelRows(),
    completion_semantics: completionCaveat(),
    retention: retentionSummary(),
    teacher_funnel: teacherFunnelSummary(teachers),
    teachers,
    students: studentRows(),
    class_days: classDayRows(range),
    assessment: assessmentRows(),
    caveats: [
      'Identifiers are salted hashes. Names, emails, and class codes are never exported.',
      'Active-day and retention figures are lower bounds: only quiz_attempts is append-only, ' +
      'progress rows are updated in place.',
      'Sessions, referrers, channels, and device data are not in this payload because the ' +
      'application does not record them. That needs an events table.',
    ],
  });
});

module.exports = router;
