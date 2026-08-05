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

// ── MIGRATIONS ────────────────────────────────────────────────────────────────
// CREATE TABLE IF NOT EXISTS only builds tables that are missing; it will not
// add columns to a table that already exists. Existing deployments therefore
// need an explicit ALTER, guarded so it is safe to run on every boot.
function addColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some(c => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Teacher engagement. Nothing recorded teacher behaviour before this, so
// "did the teacher come back after their students did work?" was unanswerable
// — by_teacher.last_activity in the analytics export could only ever be
// derived from student progress.
addColumn('teachers', 'last_login', 'TEXT'); // set on password login
addColumn('teachers', 'last_seen',  'TEXT'); // set on any authenticated request

// When a student first opened this activity. updated_at is overwritten on
// every save, so without this there is no way to separate "opened a lesson"
// from "completed a lesson" once a row has been touched more than once.
addColumn('progress', 'opened_at', 'TEXT');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_students_created    ON students(created_at);
  CREATE INDEX IF NOT EXISTS idx_progress_completed  ON progress(completed_at);
  CREATE INDEX IF NOT EXISTS idx_progress_updated    ON progress(updated_at);
  CREATE INDEX IF NOT EXISTS idx_quiz_attempted      ON quiz_attempts(attempted_at);
`);

// ── EVENT LOG ─────────────────────────────────────────────────────────────────
// Append-only. Everything above this line records *state* — a progress row is
// overwritten each time a student touches an activity, so the history is lost.
// These two tables are the only place that records what happened and when,
// which is what makes sessions, time on task, acquisition, device mix, and
// journey reconstruction possible at all.
//
// student_id is nullable on purpose: most site traffic is anonymous readers who
// never join a class, and they are exactly the population the acquisition
// questions are about. No IP address and no raw user agent is ever stored —
// only the derived device, browser, OS, and country.
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id             TEXT PRIMARY KEY,
    visitor_id     TEXT NOT NULL,
    student_id     TEXT REFERENCES students(id) ON DELETE SET NULL,
    class_id       TEXT REFERENCES classes(id) ON DELETE SET NULL,
    started_at     TEXT NOT NULL,
    last_event_at  TEXT NOT NULL,
    events         INTEGER DEFAULT 0,
    page_views     INTEGER DEFAULT 0,
    active_s       INTEGER DEFAULT 0,
    is_new_visitor INTEGER DEFAULT 0,
    signed_in      INTEGER DEFAULT 0,
    landing_page   TEXT,
    referrer_host  TEXT,
    channel        TEXT,
    utm_source     TEXT,
    utm_medium     TEXT,
    utm_campaign   TEXT,
    device         TEXT,
    browser        TEXT,
    os             TEXT,
    country        TEXT,
    bot            INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS events (
    id            TEXT PRIMARY KEY,
    occurred_at   TEXT NOT NULL,
    received_at   TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    visitor_id    TEXT NOT NULL,
    -- Intentionally not foreign keys. An append-only log should not lose rows
    -- or have them rewritten when a teacher removes a student from a class;
    -- the history of what happened stays true. The orphaned id is a bare UUID
    -- and the export hashes it, so it identifies nobody.
    student_id    TEXT,
    class_id      TEXT,
    event_type    TEXT NOT NULL,
    course        TEXT,
    unit          TEXT,
    lesson        TEXT,
    activity_type TEXT,
    item_id       TEXT,
    score         INTEGER,
    passed        INTEGER,
    attempt_no    INTEGER,
    duration_s    INTEGER,
    page          TEXT,
    meta          TEXT
  );

  -- Survives pruning: raw events age out, these daily counts are kept forever.
  CREATE TABLE IF NOT EXISTS event_daily (
    day        TEXT NOT NULL,
    course     TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL DEFAULT '',
    channel    TEXT NOT NULL DEFAULT '',
    device     TEXT NOT NULL DEFAULT '',
    events     INTEGER DEFAULT 0,
    sessions   INTEGER DEFAULT 0,
    visitors   INTEGER DEFAULT 0,
    active_s   INTEGER DEFAULT 0,
    PRIMARY KEY (day, course, event_type, channel, device)
  );

  CREATE INDEX IF NOT EXISTS idx_events_session   ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_occurred  ON events(occurred_at);
  CREATE INDEX IF NOT EXISTS idx_events_type      ON events(event_type);
  CREATE INDEX IF NOT EXISTS idx_events_student   ON events(student_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_visitor ON sessions(visitor_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_student ON sessions(student_id);
`);

module.exports = db;
