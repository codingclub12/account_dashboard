'use strict';
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'progress.db');
const db = new Database(DB_PATH);

// Performance settings
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── SCHEMA ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS teachers (
    id           TEXT PRIMARY KEY,
    email        TEXT UNIQUE NOT NULL COLLATE NOCASE,
    name         TEXT NOT NULL,
    school       TEXT,
    password_hash TEXT NOT NULL,
    verified     INTEGER DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS classes (
    id           TEXT PRIMARY KEY,
    teacher_id   TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    class_code   TEXT UNIQUE NOT NULL,
    class_name   TEXT NOT NULL,
    course       TEXT NOT NULL DEFAULT 'ap-cybersecurity',
    active       INTEGER DEFAULT 1,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS students (
    id           TEXT PRIMARY KEY,
    class_id     TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    pin_hash     TEXT NOT NULL,
    student_ref  TEXT,
    created_at   TEXT DEFAULT (datetime('now')),
    last_active  TEXT
  );

  CREATE TABLE IF NOT EXISTS progress (
    id            TEXT PRIMARY KEY,
    student_id    TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    class_id      TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    course        TEXT NOT NULL,
    unit          TEXT NOT NULL,
    lesson        TEXT NOT NULL,
    activity_type TEXT NOT NULL,
    completed     INTEGER DEFAULT 0,
    score         INTEGER,
    attempts      INTEGER DEFAULT 0,
    confidence    INTEGER,
    time_spent_s  INTEGER,
    completed_at  TEXT,
    updated_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(student_id, course, unit, lesson, activity_type)
  );

  CREATE TABLE IF NOT EXISTS quiz_attempts (
    id           TEXT PRIMARY KEY,
    student_id   TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    progress_id  TEXT REFERENCES progress(id) ON DELETE SET NULL,
    course       TEXT NOT NULL,
    unit         TEXT NOT NULL,
    lesson       TEXT NOT NULL,
    answers      TEXT,
    score        INTEGER,
    attempted_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_classes_teacher ON classes(teacher_id);
  CREATE INDEX IF NOT EXISTS idx_students_class  ON students(class_id);
  CREATE INDEX IF NOT EXISTS idx_progress_student ON progress(student_id);
  CREATE INDEX IF NOT EXISTS idx_progress_class  ON progress(class_id);
  CREATE INDEX IF NOT EXISTS idx_quiz_student    ON quiz_attempts(student_id);
`);

module.exports = db;
