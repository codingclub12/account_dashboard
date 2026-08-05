'use strict';
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRES = '30d';

// ── CLASS CODE ────────────────────────────────────────────────────────────────
// Format: CYBER-XXXX (4 alphanumeric, no ambiguous chars)
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateClassCode(prefix = 'CYBER') {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return `${prefix}-${code}`;
}

// ── UUID ──────────────────────────────────────────────────────────────────────
function newId() { return uuidv4(); }

// ── JWT (teacher auth) ────────────────────────────────────────────────────────
function signTeacherToken(teacher) {
  return jwt.sign(
    { id: teacher.id, email: teacher.email, role: 'teacher' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function verifyTeacherToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// ── SESSION TOKEN (student auth) ──────────────────────────────────────────────
// Student sessions: longer-lived JWT with student + class info
function signStudentToken(student, classCode) {
  return jwt.sign(
    { id: student.id, class_id: student.class_id, class_code: classCode, role: 'student' },
    JWT_SECRET,
    { expiresIn: '180d' } // 6 months - outlasts a school year segment
  );
}

function verifyStudentToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// ── COURSE CONFIG ─────────────────────────────────────────────────────────────
const COURSES = {
  'ap-cybersecurity': {
    label: 'AP Cybersecurity',
    units: {
      'unit-1': {
        label: 'Unit 1: Introduction to Security',
        lessons: ['1.1', '1.2', '1.3', '1.4', '1.5'],
        activities: ['lesson', 'exercise-1', 'exercise-2', 'quiz'],
      },
      'unit-2': {
        label: 'Unit 2: Securing Spaces',
        lessons: ['2.1', '2.2', '2.3', '2.4'],
        activities: ['lesson', 'exercise-1', 'exercise-2', 'quiz'],
      },
      'unit-3': {
        label: 'Unit 3: Securing Networks',
        lessons: ['3.1', '3.2', '3.3', '3.4', '3.5'],
        activities: ['lesson', 'exercise-1', 'exercise-2', 'quiz'],
      },
    },
  },
  'ap-csa': {
    label: 'AP Computer Science A',
    units: {
      'unit-1': { label: 'Unit 1: Primitive Types', lessons: [], activities: ['lesson', 'quiz'] },
      'unit-2': { label: 'Unit 2: Using Objects', lessons: [], activities: ['lesson', 'quiz'] },
      'unit-3': { label: 'Unit 3: Boolean Expressions', lessons: [], activities: ['lesson', 'quiz'] },
      'unit-4': { label: 'Unit 4: Iteration & Arrays', lessons: [], activities: ['lesson', 'quiz'] },
    },
  },
  'ap-csp': {
    label: 'AP Computer Science Principles',
    units: {
      'bi-1': { label: 'Big Idea 1: Creative Development', lessons: [], activities: ['lesson', 'quiz'] },
      'bi-2': { label: 'Big Idea 2: Data', lessons: [], activities: ['lesson', 'quiz'] },
      'bi-3': { label: 'Big Idea 3: Algorithms & Programming', lessons: [], activities: ['lesson', 'quiz'] },
      'bi-4': { label: 'Big Idea 4: Computing Systems & Networks', lessons: [], activities: ['lesson', 'quiz'] },
      'bi-5': { label: 'Big Idea 5: Impact of Computing', lessons: [], activities: ['lesson', 'quiz'] },
    },
  },
};

// ── VALIDATION ────────────────────────────────────────────────────────────────
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPin(pin) {
  return /^\d{4}$/.test(String(pin));
}

function isValidClassCode(code) {
  return /^[A-Z]+-[A-Z0-9]{4}$/.test(code);
}

function sanitize(str, maxLen = 100) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

// ── TIMESTAMPS ────────────────────────────────────────────────────────────────
// SQLite's datetime('now') produces "2026-08-05 19:30:00" — UTC, but with no
// timezone marker and a space instead of a T. `new Date()` in a browser parses
// that shape as *local* time, so every teacher west of UTC saw timestamps
// shifted into the future, which is what produced "-1d ago" in the gradebook.
//
// New writes use nowIso(). toIso() repairs the older rows on the way out, so
// the fix covers data already in the database rather than only what happens
// next. Analytics day-bucketing uses substr(ts, 1, 10) and is unaffected by
// either shape.
function nowIso() { return new Date().toISOString(); }

function toIso(value) {
  if (!value) return value;
  if (typeof value !== 'string') return value;
  if (value.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(value)) return value; // already explicit
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(value);
  return match ? `${match[1]}T${match[2]}Z` : value;
}

/** Returns a copy of `row` with the named fields normalised to explicit UTC. */
function isoFields(row, fields) {
  if (!row) return row;
  const out = Object.assign({}, row);
  for (const f of fields) if (f in out) out[f] = toIso(out[f]);
  return out;
}

// ── COURSE PREFIX for class codes ─────────────────────────────────────────────
const COURSE_PREFIXES = {
  'ap-cybersecurity': 'CYBER',
  'ap-csa':           'CSA',
  'ap-csp':           'CSP',
};

module.exports = {
  newId, generateClassCode, signTeacherToken, verifyTeacherToken,
  signStudentToken, verifyStudentToken, COURSES, COURSE_PREFIXES,
  isValidEmail, isValidPin, isValidClassCode, sanitize,
  nowIso, toIso, isoFields,
};
