'use strict';
/**
 * Event retention.
 *
 * Raw events are kept for EVENT_RETENTION_DAYS (default 180) so any metric can
 * be re-derived from scratch, including ones nobody has thought of yet. Past
 * that they are rolled into event_daily — which is kept forever — and deleted.
 * The daily table is small enough that long-range trends survive indefinitely
 * without SQLite carrying every row that ever happened.
 */
const db = require('./../db');

const DEFAULT_RETENTION_DAYS = 180;

function retentionDays() {
  const n = parseInt(process.env.EVENT_RETENTION_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

function cutoffDay(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Rolls every event older than the cutoff into event_daily, then deletes it.
 * Aggregation and deletion share a transaction, so a day is either fully
 * rolled up or left untouched — it can never be counted twice or lost.
 */
function rollupAndPrune(days) {
  const cutoff = cutoffDay(days || retentionDays());

  const aggregate = db.prepare(`
    SELECT
      substr(e.occurred_at, 1, 10)   AS day,
      COALESCE(e.course, '')         AS course,
      e.event_type                   AS event_type,
      COALESCE(s.channel, '')        AS channel,
      COALESCE(s.device, '')         AS device,
      COUNT(*)                       AS events,
      COUNT(DISTINCT e.session_id)   AS sessions,
      COUNT(DISTINCT e.visitor_id)   AS visitors,
      COALESCE(SUM(CASE WHEN e.event_type = 'heartbeat' THEN e.duration_s ELSE 0 END), 0) AS active_s
    FROM events e
    LEFT JOIN sessions s ON s.id = e.session_id
    WHERE substr(e.occurred_at, 1, 10) < ?
    GROUP BY day, course, event_type, channel, device
  `);

  const upsert = db.prepare(`
    INSERT INTO event_daily (day, course, event_type, channel, device, events, sessions, visitors, active_s)
    VALUES (@day, @course, @event_type, @channel, @device, @events, @sessions, @visitors, @active_s)
    ON CONFLICT(day, course, event_type, channel, device) DO UPDATE SET
      events   = events   + excluded.events,
      sessions = sessions + excluded.sessions,
      visitors = visitors + excluded.visitors,
      active_s = active_s + excluded.active_s
  `);

  const run = db.transaction(() => {
    const rows = aggregate.all(cutoff);
    for (const row of rows) upsert.run(row);
    const deleted = db.prepare('DELETE FROM events WHERE substr(occurred_at, 1, 10) < ?').run(cutoff);
    // Sessions only outlive their events long enough to be rolled up with them.
    const sessionsDeleted = db.prepare(`
      DELETE FROM sessions
      WHERE substr(last_event_at, 1, 10) < ?
        AND NOT EXISTS (SELECT 1 FROM events WHERE events.session_id = sessions.id)
    `).run(cutoff);
    return { cutoff, rolled_up: rows.length, events_deleted: deleted.changes, sessions_deleted: sessionsDeleted.changes };
  });

  return run();
}

/** Runs once at boot and daily after that. */
function scheduleRollup() {
  const tick = () => {
    try {
      const result = rollupAndPrune();
      if (result.events_deleted) console.log('Event rollup:', JSON.stringify(result));
    } catch (e) {
      console.error('Event rollup failed:', e);
    }
  };
  tick();
  const timer = setInterval(tick, 24 * 60 * 60 * 1000);
  if (timer.unref) timer.unref(); // never hold the process open
  return timer;
}

module.exports = { rollupAndPrune, scheduleRollup, retentionDays, cutoffDay };
