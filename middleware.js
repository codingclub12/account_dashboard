'use strict';
const { verifyTeacherToken, verifyStudentToken } = require('./utils');
const db = require('./db');

function requireTeacher(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Teacher auth required' });
  try {
    const payload = verifyTeacherToken(token);
    if (payload.role !== 'teacher') throw new Error('Not a teacher token');
    // Verify teacher still exists
    const teacher = db.prepare('SELECT id, name, email FROM teachers WHERE id = ?').get(payload.id);
    if (!teacher) return res.status(401).json({ error: 'Teacher not found' });
    // Record the visit. This is what makes teacher retention measurable:
    // last_seen advances whenever a teacher loads their dashboard, not just
    // when they type a password.
    db.prepare("UPDATE teachers SET last_seen = datetime('now') WHERE id = ?").run(teacher.id);
    req.teacher = teacher;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired teacher token' });
  }
}

function requireStudent(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Student session required' });
  try {
    const payload = verifyStudentToken(token);
    if (payload.role !== 'student') throw new Error('Not a student token');
    const student = db.prepare('SELECT id, class_id, display_name FROM students WHERE id = ?').get(payload.id);
    if (!student) return res.status(401).json({ error: 'Student not found' });
    // Update last_active
    db.prepare("UPDATE students SET last_active = datetime('now') WHERE id = ?").run(student.id);
    req.student = student;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired student session' });
  }
}

// ── ADMIN (analytics export) ──────────────────────────────────────────────────
// Guards the cross-tenant analytics endpoints, which read every teacher's and
// student's data. Fails closed: with no ADMIN_TOKEN configured the routes are
// unreachable rather than open.
function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(503).json({ error: 'Analytics export not configured (ADMIN_TOKEN unset)' });

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
  if (!token) return res.status(401).json({ error: 'Admin token required' });

  // Constant-time-ish compare: bail on length first, then diff every byte.
  if (token.length !== expected.length) return res.status(403).json({ error: 'Invalid admin token' });
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return res.status(403).json({ error: 'Invalid admin token' });

  next();
}

module.exports = { requireTeacher, requireStudent, requireAdmin };
