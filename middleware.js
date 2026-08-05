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

module.exports = { requireTeacher, requireStudent };
