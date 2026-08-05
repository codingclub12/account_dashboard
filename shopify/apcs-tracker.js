/**
 * APCSExamPrep Progress Tracker
 * Add this to every lesson, exercise, and quiz page on APCSExamPrep.com
 *
 * Usage: <script src="/cdn/shop/t/[theme]/assets/apcs-tracker.js"></script>
 *
 * On each page, also set these global vars BEFORE loading this script:
 *   window.APCS_PAGE = {
 *     course: 'ap-cybersecurity',   // ap-cybersecurity | ap-csa | ap-csp
 *     unit: 'unit-1',               // unit-1 | unit-2 | etc.
 *     lesson: '1.1',                // lesson number
 *     activity: 'lesson',           // lesson | exercise-1 | exercise-2 | quiz
 *
 *     // Optional — engagement thresholds for counting the activity complete.
 *     // Defaults: 60 seconds of active time AND 70% scroll depth.
 *     min_seconds: 60,
 *     min_scroll_pct: 70,
 *   };
 */

(function() {
  'use strict';

  const API = 'https://progress.apcsexamprep.com';

  // ── SESSION ─────────────────────────────────────────────────────────────────
  function getSession() {
    try {
      const token = localStorage.getItem('apcse_token');
      const student = JSON.parse(localStorage.getItem('apcse_student') || 'null');
      if (!token || !student) return null;
      return { token, student };
    } catch(e) { return null; }
  }

  // ── ENGAGEMENT THRESHOLDS ────────────────────────────────────────────────────
  // A page load is not a completion. Until both of these are met the activity is
  // recorded as opened-but-not-completed. Override per page with
  // window.APCS_PAGE.min_seconds / min_scroll_pct for unusually short or long ones.
  const DEFAULT_MIN_SECONDS   = 60;
  const DEFAULT_MIN_SCROLL_PCT = 70;
  // Stop counting active time after this long with no interaction, so a lesson
  // left open in a background tab over lunch doesn't become an hour of study.
  const IDLE_TIMEOUT_S = 120;
  // How often to flush accumulated time to the server mid-session.
  const FLUSH_INTERVAL_S = 30;

  // ── API CALL ─────────────────────────────────────────────────────────────────
  async function saveProgress(data, opts) {
    const session = getSession();
    if (!session) return;
    try {
      await fetch(`${API}/api/student/progress`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + session.token,
        },
        body: JSON.stringify(data),
        // keepalive lets the final flush survive the page unloading. sendBeacon
        // can't be used here because it cannot set an Authorization header.
        keepalive: !!(opts && opts.keepalive),
      });
    } catch(e) { /* silent fail — don't disrupt student experience */ }
  }

  async function saveQuizScore(data) {
    const session = getSession();
    if (!session) return;
    try {
      const r = await fetch(`${API}/api/student/quiz`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + session.token,
        },
        body: JSON.stringify(data),
      });
      return await r.json();
    } catch(e) { return null; }
  }

  // ── ANALYTICS IDENTITY ───────────────────────────────────────────────────────
  // Two identifiers, both first-party and neither tied to a person:
  //   visitor_id  persists in localStorage, so returning readers are recognisable
  //   session_id  rotates after 30 minutes of inactivity, spanning tabs
  // These are what let a signed-out visit and a later signed-in visit be counted
  // as the same person, and what carries the join to Clarity.
  const VISITOR_KEY   = 'apcse_visitor';
  const ANALYTICS_KEY = 'apcse_asession';
  const SESSION_IDLE_MS = 30 * 60 * 1000;
  const EVENT_FLUSH_MS = 15000;

  function randomId() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch(e) { /* fall through */ }
    return 'id-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }

  function readJSON(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch(e) { return null; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch(e) { /* private mode */ }
  }

  function getVisitor() {
    const stored = readJSON(VISITOR_KEY);
    if (stored && stored.id) return { id: stored.id, isNew: false };
    const visitor = { id: randomId(), created: Date.now() };
    writeJSON(VISITOR_KEY, visitor);
    return { id: visitor.id, isNew: true };
  }

  function getAnalyticsSession() {
    const now = Date.now();
    const stored = readJSON(ANALYTICS_KEY);
    if (stored && stored.id && (now - (stored.seen || 0)) < SESSION_IDLE_MS) {
      writeJSON(ANALYTICS_KEY, { id: stored.id, seen: now });
      return { id: stored.id, isNew: false };
    }
    const session = { id: randomId(), seen: now };
    writeJSON(ANALYTICS_KEY, session);
    return { id: session.id, isNew: true };
  }

  function touchAnalyticsSession(id) { writeJSON(ANALYTICS_KEY, { id: id, seen: Date.now() }); }

  // ── ANALYTICS EVENTS ─────────────────────────────────────────────────────────
  const visitor = getVisitor();
  const analyticsSession = getAnalyticsSession();
  let eventQueue = [];

  function param(name) {
    try { return new URL(window.location.href).searchParams.get(name); } catch(e) { return null; }
  }

  // Sent with every batch; the server only reads it when opening a new session.
  function eventContext() {
    return {
      is_new_visitor: visitor.isNew,
      landing_page: window.location.pathname,
      referrer: document.referrer || '',
      utm_source: param('utm_source'),
      utm_medium: param('utm_medium'),
      utm_campaign: param('utm_campaign'),
    };
  }

  function track(eventType, props) {
    eventQueue.push(Object.assign({
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      page: window.location.pathname,
    }, props || {}));
    touchAnalyticsSession(analyticsSession.id);
  }

  function flushEvents(opts) {
    if (!eventQueue.length) return;
    const batch = eventQueue;
    eventQueue = [];
    const session = getSession();
    const headers = { 'Content-Type': 'application/json' };
    // Optional: attaches the events to a student when one is signed in, and is
    // simply absent for the anonymous majority.
    if (session) headers['Authorization'] = 'Bearer ' + session.token;
    try {
      fetch(`${API}/api/events`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          session_id: analyticsSession.id,
          visitor_id: visitor.id,
          context: eventContext(),
          events: batch,
        }),
        keepalive: !!(opts && opts.keepalive),
      }).catch(function() { /* analytics must never break the page */ });
    } catch(e) { /* ignore */ }
  }

  // ── CLARITY LINK ─────────────────────────────────────────────────────────────
  // Writes our identifiers into Clarity as custom tags. Without this, Clarity
  // can show a 25-minute visit and the app can show a completion with no way to
  // confirm they were the same journey. Clarity's script may load after this
  // one, so retry briefly rather than assuming it is present.
  function linkClarity(attempt) {
    try {
      if (window.clarity) {
        window.clarity('set', 'apcs_session', analyticsSession.id);
        window.clarity('set', 'apcs_visitor', visitor.id);
        return;
      }
    } catch(e) { return; }
    if ((attempt || 0) < 10) setTimeout(function() { linkClarity((attempt || 0) + 1); }, 1000);
  }

  // ── SESSION BAR ──────────────────────────────────────────────────────────────
  function renderSessionBar(session) {
    const bar = document.createElement('div');
    bar.id = 'apcs-session-bar';
    bar.style.cssText = [
      'position:fixed', 'bottom:0', 'left:0', 'right:0', 'z-index:9999',
      'background:#1E1B4B', 'color:#fff', 'padding:8px 16px',
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'font-family:Georgia,serif', 'font-size:13px', 'gap:12px',
      'box-shadow:0 -2px 12px rgba(0,0,0,.2)',
    ].join('!important;') + '!important';

    bar.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px">
        <span style="background:#6B21A8;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:.5px">CLASS</span>
        <span style="color:#E8A020;font-weight:700;font-family:monospace">${session.student.classCode}</span>
        <span style="color:#c4b5fd">${session.student.name}</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <a href="/pages/my-progress" style="color:#c4b5fd;text-decoration:none;font-size:12px">My Progress</a>
        <span style="color:#4c1d95">|</span>
        <span id="apcs-bar-status" style="color:#6EE7B7;font-size:12px"></span>
      </div>
    `;

    document.body.appendChild(bar);

    // Add bottom padding so page content isn't hidden behind bar
    document.body.style.paddingBottom = '48px';

    return bar;
  }

  function setBarStatus(msg, color) {
    const el = document.getElementById('apcs-bar-status');
    if (el) { el.textContent = msg; if(color) el.style.color = color; }
  }

  // ── ACTIVITY METER ───────────────────────────────────────────────────────────
  // One meter per page, shared by analytics and progress tracking so both agree
  // on what "active" means. A second counts only when the tab is visible and the
  // visitor has interacted recently — a page left open in a background tab over
  // lunch is not an hour of study, and it is not an hour of session time either.
  function createActivityMeter() {
    let activeSeconds = 0;
    let maxScrollPct = 0;
    let lastInteraction = Date.now();
    const tickHandlers = [];
    const flushHandlers = [];

    function scrollPct() {
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - window.innerHeight;
      // A page shorter than the viewport is fully seen the moment it loads.
      if (scrollable <= 0) return 100;
      return Math.min(100, Math.round((window.scrollY / scrollable) * 100));
    }

    function noteInteraction() { lastInteraction = Date.now(); }
    ['scroll', 'keydown', 'mousedown', 'touchstart', 'mousemove'].forEach(evt =>
      window.addEventListener(evt, noteInteraction, { passive: true })
    );
    window.addEventListener('scroll', () => {
      maxScrollPct = Math.max(maxScrollPct, scrollPct());
    }, { passive: true });
    maxScrollPct = scrollPct();

    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if ((Date.now() - lastInteraction) / 1000 > IDLE_TIMEOUT_S) return;
      activeSeconds++;
      tickHandlers.forEach(fn => fn(activeSeconds, maxScrollPct));
    }, 1000);

    function flushAll(opts) { flushHandlers.forEach(fn => fn(opts)); }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushAll({ keepalive: true });
    });
    window.addEventListener('pagehide', () => flushAll({ keepalive: true }));

    return {
      seconds: () => activeSeconds,
      scroll: () => maxScrollPct,
      onTick: fn => tickHandlers.push(fn),
      onFlush: fn => flushHandlers.push(fn),
    };
  }

  // ── HEARTBEATS ───────────────────────────────────────────────────────────────
  // Carries active time into the event log for every page, signed in or not.
  // Only heartbeats contribute to session active time server-side, so no other
  // event can inflate it.
  function trackHeartbeats(meter) {
    let reported = 0;
    function beat(opts) {
      const delta = meter.seconds() - reported;
      if (delta < 1) return;
      reported = meter.seconds();
      track('heartbeat', { duration_s: delta });
      flushEvents(opts);
    }
    meter.onTick(seconds => { if (seconds - reported >= FLUSH_INTERVAL_S) beat(); });
    meter.onFlush(opts => beat(opts));
  }

  // ── ENGAGEMENT-BASED COMPLETION ──────────────────────────────────────────────
  // Reports time spent on the progress record and marks the activity complete
  // once both thresholds are met. Pass autoComplete: false to measure time only
  // — quizzes are completed by their score, not by dwell time.
  function trackEngagement(meter, pageInfo, onComplete, opts) {
    const autoComplete = !(opts && opts.autoComplete === false);
    const minSeconds  = pageInfo.min_seconds    || DEFAULT_MIN_SECONDS;
    const minScrollPct = pageInfo.min_scroll_pct || DEFAULT_MIN_SCROLL_PCT;

    let reportedSeconds = 0;
    let completed = false;

    // time_spent_s accumulates server-side, so always send the delta since the
    // last flush rather than the running total.
    function flushTime(flushOpts) {
      const delta = meter.seconds() - reportedSeconds;
      if (delta < 1) return;
      reportedSeconds = meter.seconds();
      saveProgress({
        course: pageInfo.course,
        unit: pageInfo.unit,
        lesson: pageInfo.lesson,
        activity_type: pageInfo.activity,
        time_spent_s: delta,
      }, flushOpts);
    }

    meter.onTick((seconds, scroll) => {
      if (autoComplete && !completed && seconds >= minSeconds && scroll >= minScrollPct) {
        completed = true;
        const total = seconds - reportedSeconds;
        reportedSeconds = seconds;
        saveProgress({
          course: pageInfo.course,
          unit: pageInfo.unit,
          lesson: pageInfo.lesson,
          activity_type: pageInfo.activity,
          completed: true,
          time_spent_s: total,
        }).then(() => onComplete && onComplete());
        track('activity_complete', {
          course: pageInfo.course, unit: pageInfo.unit, lesson: pageInfo.lesson,
          activity_type: pageInfo.activity, duration_s: seconds,
        });
        return;
      }
      if (seconds - reportedSeconds >= FLUSH_INTERVAL_S) flushTime();
    });

    // Capture the tail of the visit, including the common case of a student who
    // reads for a while and then navigates away without hitting the threshold.
    meter.onFlush(flushOpts => flushTime(flushOpts));
  }

  // ── MAIN INIT ────────────────────────────────────────────────────────────────
  function init() {
    const session = getSession();
    const pageInfo = window.APCS_PAGE;
    const meter = createActivityMeter();

    // Analytics runs on every page, whether or not APCS_PAGE is set and whether
    // or not anyone is signed in. Most of the traffic worth understanding —
    // organic search readers, a link shared into a Teams channel — never signs
    // in and never touches a lesson page, and used to be invisible here.
    linkClarity();
    track('page_view', pageInfo ? {
      course: pageInfo.course, unit: pageInfo.unit,
      lesson: pageInfo.lesson, activity_type: pageInfo.activity,
    } : null);
    trackHeartbeats(meter);
    flushEvents();
    setInterval(() => flushEvents(), EVENT_FLUSH_MS);

    if (!pageInfo) return; // Not a tracked lesson page — analytics only
    if (!session) {
      // Show subtle "Join class" prompt for non-logged-in students
      renderJoinPrompt();
      return;
    }

    const bar = renderSessionBar(session);

    // Record the open immediately (completed: false), then let engagement
    // tracking decide whether it becomes a completion. Previously this fired
    // completed: true on page load, which meant "opened a lesson page" and
    // "completed a lesson" were the same number in every report.
    if (pageInfo.activity !== 'quiz') {
      saveProgress({
        course: pageInfo.course,
        unit: pageInfo.unit,
        lesson: pageInfo.lesson,
        activity_type: pageInfo.activity,
        completed: false,
      }).then(() => {
        setBarStatus('Tracking progress\u2026', '#c4b5fd');
      });
      track('activity_open', {
        course: pageInfo.course, unit: pageInfo.unit,
        lesson: pageInfo.lesson, activity_type: pageInfo.activity,
      });

      trackEngagement(meter, pageInfo, () => {
        setBarStatus('\u2713 Lesson complete', '#6EE7B7');
      });
    } else {
      // Quizzes complete on score, but their time on task is still worth having.
      trackEngagement(meter, pageInfo, null, { autoComplete: false });
    }

    // Expose global function for quiz pages to call when quiz completes.
    // `points` is optional: pass { earned, max } and the gradebook can render
    // "2/5" instead of inferring a scale from the percentage alone.
    window.APCS_saveQuizScore = async function(score, answers, points) {
      setBarStatus('Saving score\u2026', '#c4b5fd');
      const result = await saveQuizScore({
        course: pageInfo.course,
        unit: pageInfo.unit,
        lesson: pageInfo.lesson,
        score: score,
        earned_points: points ? points.earned : undefined,
        max_points: points ? points.max : undefined,
        answers: answers || {},
      });
      if (result && result.ok) {
        setBarStatus('\u2713 Score saved: ' + score + '%', '#6EE7B7');
      }
      track('quiz_submit', {
        course: pageInfo.course, unit: pageInfo.unit, lesson: pageInfo.lesson,
        activity_type: 'quiz', item_id: pageInfo.lesson + '-quiz',
        score: score, passed: result ? !!result.passed : null,
        duration_s: meter.seconds(),
      });
      flushEvents();
      return result;
    };

    // Records a point-scored result for the current activity — 3 of 4 lesson
    // checkpoints, 7 of 7 exercise questions. Preferred over a bare percentage,
    // because it carries the activity's own denominator: without it a consumer
    // has to invent a scale, which is how lessons ended up rendered as "/100".
    window.APCS_savePoints = function(earned, max) {
      return saveProgress({
        course: pageInfo.course,
        unit: pageInfo.unit,
        lesson: pageInfo.lesson,
        activity_type: pageInfo.activity,
        earned_points: earned,
        max_points: max,
      });
    };

    // Exposed for pages that grade individual items (CFUs, code exercises) and
    // want them in the event log without a full quiz submission.
    window.APCS_trackItem = function(itemId, score, passed, attemptNo) {
      track('item_attempt', {
        course: pageInfo.course, unit: pageInfo.unit, lesson: pageInfo.lesson,
        activity_type: pageInfo.activity, item_id: String(itemId),
        score: score, passed: passed, attempt_no: attemptNo,
      });
    };

    // Expose global function for confidence rating
    window.APCS_saveConfidence = function(rating) {
      saveProgress({
        course: pageInfo.course,
        unit: pageInfo.unit,
        lesson: pageInfo.lesson,
        activity_type: pageInfo.activity,
        confidence: rating,
      });
    };
  }

  function renderJoinPrompt() {
    const prompt = document.createElement('div');
    prompt.style.cssText = [
      'position:fixed', 'bottom:0', 'left:0', 'right:0', 'z-index:9998',
      'background:#EDE9FE', 'padding:10px 16px',
      'display:flex', 'align-items:center', 'justify-content:center', 'gap:12px',
      'font-family:Georgia,serif', 'font-size:13px',
      'box-shadow:0 -2px 8px rgba(107,33,168,.1)',
    ].join('!important;') + '!important';

    prompt.innerHTML = `
      <span style="color:#4c1d95;font-weight:600">Track your progress with a class code</span>
      <a href="/pages/join" style="background:#6B21A8;color:#fff;padding:6px 14px;border-radius:5px;font-size:12px;font-weight:700;text-decoration:none">Join Class</a>
      <button onclick="this.parentElement.remove()" style="background:none;border:none;color:#9CA3AF;cursor:pointer;font-size:18px;padding:0;line-height:1">&times;</button>
    `;
    document.body.appendChild(prompt);
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
