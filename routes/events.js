'use strict';
/**
 * Event ingest.
 *
 * Deliberately open to unauthenticated callers. The traffic this is meant to
 * explain — organic readers arriving from search, a link shared in a Teams
 * channel, a teacher previewing a lesson before assigning it — is almost all
 * signed out. Requiring a student token would have captured only the classroom
 * population and left the acquisition questions exactly as unanswerable as
 * they were before.
 *
 * Being open means the endpoint has to defend itself: a strict event-type
 * whitelist, hard caps on batch size and string length, clamped timestamps, and
 * per-IP and per-session rate limits. It stores no IP address and no raw user
 * agent; see lib/enrich.js.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');
const { newId, verifyStudentToken } = require('../utils');
const { enrichRequest, classifyChannel, hostOf } = require('../lib/enrich');

const OWN_HOSTS = ['apcsexamprep.com', 'localhost', '127.0.0.1'];

// Anything not on this list is dropped. New event types are a deliberate
// change here, not something a page can invent.
const EVENT_TYPES = new Set([
  'session_start',
  'page_view',
  'activity_open',
  'activity_complete',
  'item_attempt',
  'quiz_submit',
  'class_join',
  'heartbeat',
  'teacher_dashboard_view',
  'cta_click',
]);

const MAX_EVENTS_PER_REQUEST = 50;
const MAX_STRING = 120;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
// In-memory sliding windows. Single Railway instance with a single SQLite file,
// so per-process state is per-deployment state.
const WINDOW_MS = 60000;
const MAX_REQUESTS_PER_IP = parseInt(process.env.EVENT_RATE_LIMIT_IP, 10) || 120;
const MAX_REQUESTS_PER_SESSION = parseInt(process.env.EVENT_RATE_LIMIT_SESSION, 10) || 60;
const buckets = new Map(); // key → array of timestamps

// Salted per boot so the keys cannot be reversed to an IP even in a heap dump.
const IP_SALT = crypto.randomBytes(16).toString('hex');
function ipKey(req) {
  return 'ip:' + crypto.createHash('sha256').update(IP_SALT + ':' + (req.ip || '')).digest('hex').slice(0, 16);
}

function overLimit(key, max, now) {
  const hits = (buckets.get(key) || []).filter(t => now - t < WINDOW_MS);
  hits.push(now);
  buckets.set(key, hits);
  return hits.length > max;
}

// Keep the map from growing without bound on a long-lived process.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, hits] of buckets) {
    const live = hits.filter(t => t > cutoff);
    if (live.length) buckets.set(key, live); else buckets.delete(key);
  }
}, WINDOW_MS).unref();

// ── VALIDATION ────────────────────────────────────────────────────────────────
function str(v, max = MAX_STRING) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

function int(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// Clock skew and replayed batches are both real. Anything outside a sane window
// is pulled back to now rather than trusted or dropped.
function clampTimestamp(value, nowMs) {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return new Date(nowMs).toISOString();
  const min = nowMs - 7 * 86400000;
  const max = nowMs + 5 * 60000;
  return new Date(Math.max(min, Math.min(max, t))).toISOString();
}

// A student token is optional. When present it links the session to a student;
// when absent or invalid the session simply stays anonymous.
function resolveStudent(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const payload = verifyStudentToken(token);
    if (payload.role !== 'student') return null;
    return db.prepare('SELECT id, class_id FROM students WHERE id = ?').get(payload.id) || null;
  } catch (e) {
    return null;
  }
}

// ── INGEST ────────────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const now = Date.now();
  const body = req.body || {};

  const sessionId = str(body.session_id, 64);
  const visitorId = str(body.visitor_id, 64);
  if (!sessionId || !ID_RE.test(sessionId)) return res.status(400).json({ error: 'Invalid session_id' });
  if (!visitorId || !ID_RE.test(visitorId)) return res.status(400).json({ error: 'Invalid visitor_id' });

  if (overLimit(ipKey(req), MAX_REQUESTS_PER_IP, now) ||
      overLimit('sess:' + sessionId, MAX_REQUESTS_PER_SESSION, now)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const incoming = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS_PER_REQUEST) : [];
  if (!incoming.length) return res.status(400).json({ error: 'No events' });

  const student = resolveStudent(req);
  const ctx = body.context || {};
  const derived = enrichRequest(req, OWN_HOSTS);
  const nowIso = new Date(now).toISOString();

  const events = [];
  for (const e of incoming) {
    const type = str(e.event_type, 40);
    if (!type || !EVENT_TYPES.has(type)) continue; // unknown types are dropped, not stored
    events.push({
      id: newId(),
      occurred_at: clampTimestamp(e.occurred_at, now),
      received_at: nowIso,
      session_id: sessionId,
      visitor_id: visitorId,
      student_id: student ? student.id : null,
      class_id: student ? student.class_id : null,
      event_type: type,
      course: str(e.course, 40),
      unit: str(e.unit, 40),
      lesson: str(e.lesson, 40),
      activity_type: str(e.activity_type, 40),
      item_id: str(e.item_id, 60),
      score: int(e.score, 0, 100),
      passed: e.passed === undefined || e.passed === null ? null : (e.passed ? 1 : 0),
      attempt_no: int(e.attempt_no, 0, 1000),
      duration_s: int(e.duration_s, 0, 86400),
      page: str(e.page, 200),
      meta: e.meta && typeof e.meta === 'object' ? JSON.stringify(e.meta).slice(0, 500) : null,
    });
  }
  if (!events.length) return res.status(400).json({ error: 'No recognised events' });

  const pageViews = events.filter(e => e.event_type === 'page_view').length;
  // Only heartbeats carry active time, so nothing else can inflate it.
  const activeSeconds = events
    .filter(e => e.event_type === 'heartbeat')
    .reduce((sum, e) => sum + (e.duration_s || 0), 0);

  const insertEvent = db.prepare(`
    INSERT INTO events (id, occurred_at, received_at, session_id, visitor_id, student_id, class_id,
      event_type, course, unit, lesson, activity_type, item_id, score, passed, attempt_no,
      duration_s, page, meta)
    VALUES (@id, @occurred_at, @received_at, @session_id, @visitor_id, @student_id, @class_id,
      @event_type, @course, @unit, @lesson, @activity_type, @item_id, @score, @passed, @attempt_no,
      @duration_s, @page, @meta)
  `);

  const existing = db.prepare('SELECT id FROM sessions WHERE id = ?');
  const insertSession = db.prepare(`
    INSERT INTO sessions (id, visitor_id, student_id, class_id, started_at, last_event_at,
      events, page_views, active_s, is_new_visitor, signed_in, landing_page, referrer_host,
      channel, utm_source, utm_medium, utm_campaign, device, browser, os, country, bot)
    VALUES (@id, @visitor_id, @student_id, @class_id, @started_at, @last_event_at,
      @events, @page_views, @active_s, @is_new_visitor, @signed_in, @landing_page, @referrer_host,
      @channel, @utm_source, @utm_medium, @utm_campaign, @device, @browser, @os, @country, @bot)
  `);
  const updateSession = db.prepare(`
    UPDATE sessions SET
      last_event_at = @last_event_at,
      events = events + @events,
      page_views = page_views + @page_views,
      active_s = active_s + @active_s,
      -- A session can start signed out and sign in partway through; once it is
      -- attached to a student it stays attached.
      student_id = COALESCE(student_id, @student_id),
      class_id = COALESCE(class_id, @class_id),
      signed_in = MAX(signed_in, @signed_in)
    WHERE id = @id
  `);

  const write = db.transaction(() => {
    if (existing.get(sessionId)) {
      updateSession.run({
        id: sessionId,
        last_event_at: nowIso,
        events: events.length,
        page_views: pageViews,
        active_s: activeSeconds,
        student_id: student ? student.id : null,
        class_id: student ? student.class_id : null,
        signed_in: student ? 1 : 0,
      });
    } else {
      const referrer = str(ctx.referrer, 300);
      insertSession.run({
        id: sessionId,
        visitor_id: visitorId,
        student_id: student ? student.id : null,
        class_id: student ? student.class_id : null,
        started_at: events[0].occurred_at,
        last_event_at: nowIso,
        events: events.length,
        page_views: pageViews,
        active_s: activeSeconds,
        is_new_visitor: ctx.is_new_visitor ? 1 : 0,
        signed_in: student ? 1 : 0,
        landing_page: str(ctx.landing_page, 200),
        referrer_host: hostOf(referrer),
        channel: classifyChannel({
          referrer,
          utm_medium: str(ctx.utm_medium, 60),
          utm_source: str(ctx.utm_source, 60),
          ownHosts: OWN_HOSTS,
        }),
        utm_source: str(ctx.utm_source, 60),
        utm_medium: str(ctx.utm_medium, 60),
        utm_campaign: str(ctx.utm_campaign, 60),
        device: derived.device,
        browser: derived.browser,
        os: derived.os,
        country: derived.country,
        bot: derived.bot,
      });
    }
    for (const e of events) insertEvent.run(e);
  });

  try {
    write();
  } catch (err) {
    console.error('Event ingest error:', err);
    return res.status(500).json({ error: 'Failed to record events' });
  }

  // The browser has nothing to do with the response; keep it empty and cheap.
  res.status(204).end();
});

module.exports = router;
