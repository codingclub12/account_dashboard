'use strict';
// End-to-end test for the event log: ingest validation and defences, session
// derivation, the traffic/acquisition/device/journey endpoints, and retention.
const fs = require('fs');
const path = require('path');

const DB = path.join(require('os').tmpdir(), 'apcs-events-test.db');
for (const f of [DB, DB + '-shm', DB + '-wal']) if (fs.existsSync(f)) fs.unlinkSync(f);

process.env.DB_PATH = DB;
process.env.JWT_SECRET = 'test-secret-'.repeat(6);
process.env.ADMIN_TOKEN = 'admin-token-for-tests';
process.env.ANALYTICS_SALT = 'test-salt';
// Low enough to trip deliberately without flooding the run.
process.env.EVENT_RATE_LIMIT_SESSION = '5';
process.env.EVENT_RATE_LIMIT_IP = '400';

const ROOT = path.join(__dirname, '..');
const PORT = 4124;
const app = require(path.join(ROOT, 'server.js'));
const db = require(path.join(ROOT, 'db.js'));
const { rollupAndPrune } = require(path.join(ROOT, 'lib', 'rollup.js'));

const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { Authorization: 'Bearer admin-token-for-tests' };

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log('  ok   ' + label); }
  else { failures++; console.log('  FAIL ' + label + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
}

async function api(method, url, body, headers) {
  const r = await fetch(BASE + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 204 or csv */ }
  return { status: r.status, json, text };
}

let sessionCounter = 0;
function newSessionId() { return 'sess-0000-' + (++sessionCounter).toString().padStart(4, '0'); }

function ingest(opts) {
  const headers = { 'User-Agent': opts.ua || CHROME_UA };
  if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
  return api('POST', '/api/events', {
    session_id: opts.session_id,
    visitor_id: opts.visitor_id || 'visitor-000-1',
    context: opts.context,
    events: opts.events,
  }, headers);
}

const pageView = extra => Object.assign({ event_type: 'page_view', occurred_at: new Date().toISOString(), page: '/lessons/1-1' }, extra);

(async () => {
  await new Promise(resolve => { app.listen(PORT, resolve); });

  console.log('\n── ingest validation ──');
  check('rejects malformed session_id',
    (await ingest({ session_id: 'short', events: [pageView()] })).status === 400);
  check('rejects malformed visitor_id',
    (await ingest({ session_id: newSessionId(), visitor_id: '!!', events: [pageView()] })).status === 400);
  check('rejects empty batch',
    (await ingest({ session_id: newSessionId(), events: [] })).status === 400);
  check('rejects a batch of only unknown types',
    (await ingest({ session_id: newSessionId(), events: [{ event_type: 'exfiltrate' }] })).status === 400);

  const mixedId = newSessionId();
  check('drops unknown types but keeps known ones',
    (await ingest({ session_id: mixedId, events: [pageView(), { event_type: 'not-a-real-type' }] })).status === 204);
  check('only the known event was stored',
    db.prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?').get(mixedId).n === 1);

  console.log('\n── anonymous session ──');
  const anonId = newSessionId();
  const anon = await ingest({
    session_id: anonId,
    visitor_id: 'visitor-000-2',
    context: { is_new_visitor: true, landing_page: '/lessons/1-1', referrer: 'https://www.google.com/search?q=ap+csa' },
    events: [pageView(), { event_type: 'heartbeat', duration_s: 40, occurred_at: new Date().toISOString() }],
  });
  check('anonymous ingest accepted without any auth', anon.status === 204, anon.status);
  const anonSession = db.prepare('SELECT * FROM sessions WHERE id = ?').get(anonId);
  check('session row created', !!anonSession);
  check('student_id is null for anonymous', anonSession.student_id === null, anonSession.student_id);
  check('channel derived as organic', anonSession.channel === 'organic', anonSession.channel);
  check('referrer host derived', anonSession.referrer_host === 'google.com', anonSession.referrer_host);
  check('device derived from UA', anonSession.device === 'desktop', anonSession.device);
  check('browser derived from UA', anonSession.browser === 'Chrome', anonSession.browser);
  check('os derived from UA', anonSession.os === 'Windows', anonSession.os);
  check('active_s from heartbeat only', anonSession.active_s === 40, anonSession.active_s);
  check('page_views counted', anonSession.page_views === 1, anonSession.page_views);
  check('new visitor flagged', anonSession.is_new_visitor === 1);

  // The whole point of not storing raw UA or IP: verify nothing resembling
  // either reached the database.
  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
  check('no ip column on sessions', !sessionColumns.some(c => /ip|addr/i.test(c)), sessionColumns);
  check('no user agent column on sessions', !sessionColumns.some(c => /agent|ua_/i.test(c)), sessionColumns);
  check('raw UA not stored anywhere in the row',
    !JSON.stringify(anonSession).includes('AppleWebKit'), anonSession);

  console.log('\n── channel classification ──');
  async function channelFor(referrer, ctx) {
    const id = newSessionId();
    await ingest({ session_id: id, context: Object.assign({ referrer }, ctx || {}), events: [pageView()] });
    return db.prepare('SELECT channel FROM sessions WHERE id = ?').get(id).channel;
  }
  check('direct when no referrer', await channelFor('') === 'direct');
  check('Teams counts as classroom', await channelFor('https://teams.microsoft.com/l/x') === 'classroom');
  check('Google Classroom counts as classroom', await channelFor('https://classroom.google.com/c/abc') === 'classroom');
  check('Reddit counts as social', await channelFor('https://www.reddit.com/r/apcsa') === 'social');
  check('unknown site counts as referral', await channelFor('https://someblog.example/post') === 'referral');
  check('own domain counts as internal', await channelFor('https://www.apcsexamprep.com/lessons') === 'internal');
  check('utm_medium beats the referrer',
    await channelFor('https://www.google.com/', { utm_medium: 'cpc' }) === 'paid');

  console.log('\n── timestamp clamping ──');
  const skewId = newSessionId();
  await ingest({ session_id: skewId, events: [pageView({ occurred_at: '2099-01-01T00:00:00Z' })] });
  const skewed = db.prepare('SELECT occurred_at FROM events WHERE session_id = ?').get(skewId);
  check('far-future timestamp clamped to now', skewed.occurred_at.slice(0, 4) !== '2099', skewed);

  console.log('\n── signed-in session ──');
  await api('POST', '/api/teacher/register', { email: 'sam@example.edu', password: 'password123', name: 'Sam Rivera' });
  const login = await api('POST', '/api/teacher/login', { email: 'sam@example.edu', password: 'password123' });
  const cls = await api('POST', '/api/teacher/classes', { class_name: 'Period 1', course: 'ap-cybersecurity' },
    { Authorization: 'Bearer ' + login.json.token });
  const join = await api('POST', '/api/student/join',
    { class_code: cls.json.class.class_code, display_name: 'Avery', pin: '1234' });
  const studentToken = join.json.token;
  const studentId = join.json.student.id;

  // Starts signed out, then signs in mid-session — the session should attach.
  const upgradeId = newSessionId();
  await ingest({ session_id: upgradeId, visitor_id: 'visitor-000-3', events: [pageView()] });
  const beforeLogin = db.prepare('SELECT student_id, signed_in FROM sessions WHERE id = ?').get(upgradeId);
  check('session starts anonymous', beforeLogin.student_id === null && beforeLogin.signed_in === 0, beforeLogin);

  await ingest({
    session_id: upgradeId, visitor_id: 'visitor-000-3', token: studentToken,
    events: [{ event_type: 'class_join', occurred_at: new Date().toISOString() },
             { event_type: 'heartbeat', duration_s: 25, occurred_at: new Date().toISOString() }],
  });
  const afterLogin = db.prepare('SELECT student_id, class_id, signed_in, events, active_s FROM sessions WHERE id = ?').get(upgradeId);
  check('session attaches to the student', afterLogin.student_id === studentId, afterLogin);
  check('session attaches to the class', afterLogin.class_id === cls.json.class.id, afterLogin);
  check('signed_in flips to 1', afterLogin.signed_in === 1, afterLogin);
  check('counters accumulate across batches', afterLogin.events === 3, afterLogin);
  check('active_s accumulates across batches', afterLogin.active_s === 25, afterLogin);

  const invalidTokenId = newSessionId();
  await ingest({ session_id: invalidTokenId, token: 'not.a.real.token', events: [pageView()] });
  check('invalid token degrades to anonymous rather than erroring',
    db.prepare('SELECT student_id FROM sessions WHERE id = ?').get(invalidTokenId).student_id === null);

  console.log('\n── bot handling ──');
  const botId = newSessionId();
  await ingest({ session_id: botId, ua: BOT_UA, visitor_id: 'visitor-bot-1', events: [pageView()] });
  check('bot session flagged', db.prepare('SELECT bot FROM sessions WHERE id = ?').get(botId).bot === 1);

  const mobileId = newSessionId();
  await ingest({ session_id: mobileId, ua: IPHONE_UA, visitor_id: 'visitor-000-4', events: [pageView()] });
  const mobile = db.prepare('SELECT device, os FROM sessions WHERE id = ?').get(mobileId);
  check('iPhone detected as mobile/iOS', mobile.device === 'mobile' && mobile.os === 'iOS', mobile);

  console.log('\n── traffic endpoints ──');
  const traffic = await api('GET', '/api/analytics/traffic', null, ADMIN);
  check('traffic 200', traffic.status === 200);
  const today = new Date().toISOString().slice(0, 10);
  const todayRow = traffic.json.rows.find(r => r.date === today);
  check('today has sessions', todayRow && todayRow.sessions > 0, todayRow);
  check('active minutes reported', todayRow.active_minutes >= 1, todayRow);

  const withBots = await api('GET', '/api/analytics/traffic?include_bots=1', null, ADMIN);
  const botRow = withBots.json.rows.find(r => r.date === today);
  check('bots excluded by default', botRow.sessions > todayRow.sessions, { botRow, todayRow });

  const acq = await api('GET', '/api/analytics/acquisition', null, ADMIN);
  const channels = Object.fromEntries(acq.json.by_channel.map(c => [c.channel, c.sessions]));
  check('organic channel present', channels.organic >= 1, channels);
  check('classroom channel present', channels.classroom >= 2, channels);
  check('bot session absent from acquisition', !Object.keys(channels).includes('bot'), channels);
  check('new vs returning populated', acq.json.new_vs_returning.total > 0, acq.json.new_vs_returning);
  check('top referrers populated', acq.json.top_referrers.length > 0, acq.json.top_referrers);

  const devices = await api('GET', '/api/analytics/devices', null, ADMIN);
  const deviceMap = Object.fromEntries(devices.json.device.map(d => [d.value, d.sessions]));
  check('desktop and mobile both reported', deviceMap.desktop > 0 && deviceMap.mobile === 1, deviceMap);
  check('browsers reported', devices.json.browser.some(b => b.value === 'Chrome'), devices.json.browser);

  const journeys = await api('GET', '/api/analytics/journeys', null, ADMIN);
  check('journeys 200', journeys.status === 200);
  check('page_view-only journey is the most common',
    journeys.json.rows[0].path === 'page_view', journeys.json.rows.slice(0, 3));
  const multiStep = journeys.json.rows.find(r => r.path.includes('→'));
  check('multi-step journey reconstructed', !!multiStep, journeys.json.rows);
  check('heartbeats excluded from journeys',
    !journeys.json.rows.some(r => r.path.includes('heartbeat')), journeys.json.rows);

  console.log('\n── summary integration ──');
  const summary = await api('GET', '/api/analytics/summary', null, ADMIN);
  for (const key of ['traffic', 'journeys']) {
    check('summary includes ' + key, Array.isArray(summary.json[key]) && summary.json[key].length > 0);
  }
  check('summary includes acquisition', !!summary.json.acquisition.by_channel.length);
  check('summary includes devices', !!summary.json.devices.device.length);
  check('stale caveat about missing sessions is gone',
    !JSON.stringify(summary.json.caveats).includes('does not record them'), summary.json.caveats);
  check('retention horizon stated in caveats',
    JSON.stringify(summary.json.caveats).includes('180 days'), summary.json.caveats);

  console.log('\n── retention rollup ──');
  const oldDay = '2020-01-01';
  db.prepare(`UPDATE events SET occurred_at = ? WHERE session_id = ?`).run(oldDay + 'T10:00:00.000Z', anonId);
  db.prepare(`UPDATE sessions SET started_at = ?, last_event_at = ? WHERE id = ?`)
    .run(oldDay + 'T10:00:00.000Z', oldDay + 'T10:00:00.000Z', anonId);

  const before = db.prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?').get(anonId).n;
  check('old events present before pruning', before === 2, before);

  const result = rollupAndPrune(180);
  check('rollup reported deletions', result.events_deleted === 2, result);
  check('old events deleted', db.prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?').get(anonId).n === 0);
  check('old session deleted', !db.prepare('SELECT id FROM sessions WHERE id = ?').get(anonId));

  const daily = db.prepare('SELECT * FROM event_daily WHERE day = ?').all(oldDay);
  check('daily rollup rows written', daily.length === 2, daily);
  const heartbeatRow = daily.find(d => d.event_type === 'heartbeat');
  check('rollup preserved active seconds', heartbeatRow.active_s === 40, heartbeatRow);
  check('rollup preserved the channel dimension', heartbeatRow.channel === 'organic', heartbeatRow);

  const rerun = rollupAndPrune(180);
  check('re-running the prune is a no-op', rerun.events_deleted === 0, rerun);
  check('no double counting after re-run',
    db.prepare('SELECT SUM(active_s) AS s FROM event_daily WHERE day = ?').get(oldDay).s === 40);

  console.log('\n── rate limiting ──');
  const floodId = newSessionId();
  let limited = false;
  for (let i = 0; i < 8; i++) {
    const r = await ingest({ session_id: floodId, events: [pageView()] });
    if (r.status === 429) { limited = true; break; }
  }
  check('per-session rate limit trips', limited);

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
