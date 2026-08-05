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

  // ── API CALL ─────────────────────────────────────────────────────────────────
  async function saveProgress(data) {
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

  // ── MAIN INIT ────────────────────────────────────────────────────────────────
  function init() {
    const session = getSession();
    const pageInfo = window.APCS_PAGE;

    if (!pageInfo) return; // No page info set — do nothing
    if (!session) {
      // Show subtle "Join class" prompt for non-logged-in students
      renderJoinPrompt();
      return;
    }

    const bar = renderSessionBar(session);

    // Mark lesson as visited (non-scored completion)
    if (pageInfo.activity !== 'quiz') {
      saveProgress({
        course: pageInfo.course,
        unit: pageInfo.unit,
        lesson: pageInfo.lesson,
        activity_type: pageInfo.activity,
        completed: true,
      }).then(() => {
        setBarStatus('\u2713 Progress saved', '#6EE7B7');
      });
    }

    // Expose global function for quiz pages to call when quiz completes
    window.APCS_saveQuizScore = async function(score, answers) {
      setBarStatus('Saving score\u2026', '#c4b5fd');
      const result = await saveQuizScore({
        course: pageInfo.course,
        unit: pageInfo.unit,
        lesson: pageInfo.lesson,
        score: score,
        answers: answers || {},
      });
      if (result && result.ok) {
        setBarStatus('\u2713 Score saved: ' + score + '%', '#6EE7B7');
      }
      return result;
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
