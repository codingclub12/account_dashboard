'use strict';
// End-to-end smoke test for the analytics export: boots the real app against a
// throwaway SQLite file, drives the public API, then checks every new endpoint.
const fs = require('fs');
const path = require('path');

const DB = path.join(require('os').tmpdir(), 'apcs-analytics-test.db');
for (const f of [DB, DB + '-shm', DB + '-wal']) if (fs.existsSync(f)) fs.unlinkSync(f);

process.env.DB_PATH = DB;
process.env.JWT_SECRET = 'test-secret-'.repeat(6);
process.env.ADMIN_TOKEN = 'admin-token-for-tests';
process.env.ANALYTICS_SALT = 'test-salt';
process.env.PORT = '4123';

const ROOT = path.join(__dirname, '..');
const app = require(path.join(ROOT, 'server.js'));
const db = require(path.join(ROOT, 'db.js'));

const BASE = 'http://127.0.0.1:4123';
const ADMIN = { Authorization: 'Bearer admin-token-for-tests' };

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
  try { json = JSON.parse(text); } catch (e) { /* csv or error page */ }
  return { status: r.status, json, text };
}

// Rewrites a timestamp so cohort windows can be exercised without waiting days.
function backdate(table, column, id, day) {
  db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(day, id);
}
function dayAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

(async () => {
  await new Promise(resolve => { app.listen(4123, resolve); });

  console.log('\n── migrations ──');
  const teacherCols = db.prepare('PRAGMA table_info(teachers)').all().map(c => c.name);
  check('teachers.last_login added', teacherCols.includes('last_login'), teacherCols);
  check('teachers.last_seen added', teacherCols.includes('last_seen'));
  const progressCols = db.prepare('PRAGMA table_info(progress)').all().map(c => c.name);
  check('progress.opened_at added', progressCols.includes('opened_at'));

  // Migrations must be idempotent — the app re-runs them on every boot.
  delete require.cache[require.resolve(path.join(ROOT, 'db.js'))];
  let reloadOk = true;
  try { require(path.join(ROOT, 'db.js')); } catch (e) { reloadOk = false; console.log(e.message); }
  check('migrations re-run cleanly', reloadOk);

  console.log('\n── seed ──');
  const reg = await api('POST', '/api/teacher/register',
    { email: 'sam@example.edu', password: 'password123', name: 'Sam Rivera', school: 'Test High' });
  check('teacher registered', reg.status === 201, reg.json);
  const teacherId = reg.json.teacher.id;

  const login = await api('POST', '/api/teacher/login', { email: 'sam@example.edu', password: 'password123' });
  check('teacher login', login.status === 200);
  const tAuth = { Authorization: 'Bearer ' + login.json.token };

  const afterLogin = db.prepare('SELECT last_login, last_seen FROM teachers WHERE id = ?').get(teacherId);
  check('last_login set on login', !!afterLogin.last_login, afterLogin);

  const cls = await api('POST', '/api/teacher/classes', { class_name: 'Period 1', course: 'ap-cybersecurity' }, tAuth);
  check('class created', cls.status === 201, cls.json);
  const code = cls.json.class.class_code;

  // A second teacher who registers and stops — should stall at created_a_class.
  const reg2 = await api('POST', '/api/teacher/register',
    { email: 'lee@example.edu', password: 'password123', name: 'Lee Park' });
  check('second teacher registered', reg2.status === 201);

  // Students: one who works, one who only opens a page, one who never shows up.
  const students = [];
  for (const name of ['Avery', 'Blake', 'Casey']) {
    const j = await api('POST', '/api/student/join', { class_code: code, display_name: name, pin: '1234' });
    students.push({ name, token: j.json.token, id: j.json.student.id, status: j.status });
  }
  check('three students joined', students.every(s => s.status === 201), students.map(s => s.status));

  const sAuth = s => ({ Authorization: 'Bearer ' + s.token });

  // Avery: opens a lesson, accrues time, completes it, and passes a quiz.
  await api('POST', '/api/student/progress',
    { course: 'ap-cybersecurity', unit: 'unit-1', lesson: '1.1', activity_type: 'lesson', completed: false }, sAuth(students[0]));
  await api('POST', '/api/student/progress',
    { course: 'ap-cybersecurity', unit: 'unit-1', lesson: '1.1', activity_type: 'lesson', time_spent_s: 45 }, sAuth(students[0]));
  await api('POST', '/api/student/progress',
    { course: 'ap-cybersecurity', unit: 'unit-1', lesson: '1.1', activity_type: 'lesson', completed: true, time_spent_s: 30 }, sAuth(students[0]));
  const quiz = await api('POST', '/api/student/quiz',
    { course: 'ap-cybersecurity', unit: 'unit-1', lesson: '1.1', score: 80, answers: { q1: 'A' } }, sAuth(students[0]));
  check('quiz submitted and passed', quiz.status === 200 && quiz.json.passed === true, quiz.json);

  // Blake: opens a lesson but never meets the threshold.
  await api('POST', '/api/student/progress',
    { course: 'ap-cybersecurity', unit: 'unit-1', lesson: '1.2', activity_type: 'lesson', completed: false }, sAuth(students[1]));
  await api('POST', '/api/student/progress',
    { course: 'ap-cybersecurity', unit: 'unit-1', lesson: '1.2', activity_type: 'lesson', time_spent_s: 20 }, sAuth(students[1]));

  console.log('\n── step 3: time accumulates as deltas ──');
  const avery = db.prepare(`SELECT time_spent_s, completed, opened_at, completed_at FROM progress
    WHERE student_id = ? AND activity_type = 'lesson'`).get(students[0].id);
  check('time_spent_s summed to 75', avery.time_spent_s === 75, avery);
  check('opened_at recorded', !!avery.opened_at, avery);
  check('completed_at recorded', !!avery.completed_at, avery);

  console.log('\n── step 1: opened is not completed ──');
  const blake = db.prepare(`SELECT completed, time_spent_s FROM progress WHERE student_id = ?`).get(students[1].id);
  check('open-only row stays incomplete', blake.completed === 0, blake);
  const funnel = await api('GET', '/api/analytics/funnel', null, ADMIN);
  const stages = Object.fromEntries(funnel.json.stages.map(s => [s.stage, s.students]));
  check('Enrolled = 3', stages['Enrolled'] === 3, stages);
  check('Opened an activity = 2', stages['Opened an activity'] === 2, stages);
  check('Completed an activity = 1', stages['Completed an activity'] === 1, stages);
  check('Passed a graded item = 1', stages['Passed a graded item'] === 1, stages);
  check('completion caveat surfaced', funnel.json.completion_semantics.trustworthy === false);

  console.log('\n── step 4: exports ──');
  const auth401 = await api('GET', '/api/analytics/students');
  check('unauthenticated export rejected', auth401.status === 401, auth401.status);
  const auth403 = await api('GET', '/api/analytics/students', null, { Authorization: 'Bearer wrong-token-here!!' });
  check('bad admin token rejected', auth403.status === 403, auth403.status);

  const stu = await api('GET', '/api/analytics/students', null, ADMIN);
  check('students endpoint 200', stu.status === 200);
  check('one row per student', stu.json.rows.length === 3, stu.json.rows.length);
  const averyRow = stu.json.rows.find(r => r.graded_passed === 1);
  check('student ids are hashed', averyRow.student_id.startsWith('stu_') && !averyRow.student_id.includes(students[0].id));
  check('no name/email columns', !stu.json.columns.some(c => /name|email|code/i.test(c)), stu.json.columns);
  check('active_minutes computed', averyRow.active_minutes === 1, averyRow);
  check('graded_passed counted', averyRow.graded_passed === 1, averyRow);

  const csv = await api('GET', '/api/analytics/students?format=csv', null, ADMIN);
  check('csv format returns rows', csv.text.split('\n').length === 4, csv.text.split('\n').length);
  check('csv header matches columns', csv.text.startsWith(stu.json.columns.join(',')), csv.text.slice(0, 60));
  check('activities_completed counts all completions', averyRow.activities_completed === 2, averyRow);
  const caseyRow = stu.json.rows.find(r => r.activities_opened === 0);
  check('inactive student has null first_activity_at', caseyRow.first_activity_at === null, caseyRow);

  const cd = await api('GET', '/api/analytics/class-days', null, ADMIN);
  check('class-days 200', cd.status === 200);
  check('class-day row present', cd.json.rows.length === 1, cd.json.rows);
  check('active_students = 2', cd.json.rows[0].active_students === 2, cd.json.rows[0]);
  check('roster = 3', cd.json.rows[0].roster === 3, cd.json.rows[0]);
  check('range is populated', cd.json.range.days === 30, cd.json.range);

  const tf = await api('GET', '/api/analytics/teacher-funnel', null, ADMIN);
  const byStep = Object.fromEntries(tf.json.summary.map(s => [s.step, s.teachers]));
  check('2 registered', byStep.registered === 2, byStep);
  check('1 created a class', byStep.created_a_class === 1, byStep);
  check('1 reached first completion', byStep.first_lesson_completion === 1, byStep);
  check('0 reached ten students', byStep.ten_students_joined === 0, byStep);
  const stalled = tf.json.teachers.find(t => t.classes === 0);
  check('idle teacher stalls at created_a_class', stalled.stalled_at === 'created_a_class', stalled);
  check('week-1 return is null when unknowable', stalled.reached.returned_after_week_1 === null, stalled);
  const tfCsv = await api('GET', '/api/analytics/teacher-funnel?format=csv', null, ADMIN);
  check('teacher funnel csv flattens steps', tfCsv.text.includes('reached_ten_students_joined'), tfCsv.text.slice(0,200));
  const tenStep = tf.json.summary.find(s => s.step === 'ten_students_joined');
  check('stalled_here attributes the drop-off', tenStep.stalled_here === 1, tenStep);

  const asmt = await api('GET', '/api/analytics/assessment', null, ADMIN);
  const cats = Object.fromEntries(asmt.json.rows.map(r => [r.category, r]));
  check('lesson and quiz reported separately', !!cats.lesson && !!cats.quiz, Object.keys(cats));
  check('quiz pass rate 100', cats.quiz.pass_rate_pct === 100, cats.quiz);
  check('lesson category has no graded attempts', cats.lesson.attempted === 0, cats.lesson);

  console.log('\n── retention windows ──');
  // Backdate Avery's enrolment 20 days and plant activity on day 1 and day 10.
  backdate('students', 'created_at', students[0].id, dayAgo(20));
  const pid = db.prepare('SELECT id FROM progress WHERE student_id = ? LIMIT 1').get(students[0].id).id;
  backdate('progress', 'opened_at', pid, dayAgo(19));
  db.prepare('UPDATE quiz_attempts SET attempted_at = ? WHERE student_id = ?').run(dayAgo(10), students[0].id);

  const ret = await api('GET', '/api/analytics/retention', null, ADMIN);
  const win = Object.fromEntries(ret.json.windows.map(w => [w.window, w]));
  check('day_1 eligible excludes new students', win.day_1.eligible === 1, win.day_1);
  check('day_1 retained', win.day_1.retained === 1, win.day_1);
  check('week_2 retained via day-10 activity', win.week_2.retained === 1, win.week_2);
  check('multi-day counted', win.two_or_more_active_days.retained === 1, win.two_or_more_active_days);

  console.log('\n── summary ──');
  const sum = await api('GET', '/api/analytics/summary?days=7', null, ADMIN);
  check('summary 200', sum.status === 200);
  check('summary honours ?days', sum.json.range.days === 7, sum.json.range);
  for (const key of ['funnel', 'retention', 'teacher_funnel', 'teachers', 'students', 'class_days', 'assessment', 'caveats']) {
    check('summary includes ' + key, Array.isArray(sum.json[key]) && sum.json[key].length > 0);
  }
  check('summary leaks no emails', !JSON.stringify(sum.json).includes('example.edu'));
  check('summary leaks no class codes', !JSON.stringify(sum.json).includes(code));
  check('summary leaks no student names', !JSON.stringify(sum.json).includes('Avery'));

  console.log('\n── points carry their own denominator ──');
  // A four-checkpoint lesson: the thing that used to render as "75/100".
  await api('POST', '/api/student/progress', {
    course: 'ap-cybersecurity', unit: 'unit-1', lesson: '1.3', activity_type: 'lesson',
    earned_points: 3, max_points: 4, completed: true,
  }, sAuth(students[0]));
  const lessonRow = db.prepare(`SELECT score, earned_points, max_points FROM progress
    WHERE student_id = ? AND lesson = '1.3'`).get(students[0].id);
  check('points stored as given', lessonRow.earned_points === 3 && lessonRow.max_points === 4, lessonRow);
  check('score derived from points', lessonRow.score === 75, lessonRow);

  // Points win over a percentage sent alongside them, so the two can't disagree.
  await api('POST', '/api/student/progress', {
    course: 'ap-cybersecurity', unit: 'unit-1', lesson: '1.4', activity_type: 'exercise-1',
    score: 12, earned_points: 7, max_points: 7,
  }, sAuth(students[0]));
  const exRow = db.prepare(`SELECT score, earned_points, max_points FROM progress
    WHERE student_id = ? AND lesson = '1.4'`).get(students[0].id);
  check('points override a conflicting percentage', exRow.score === 100, exRow);

  // Existing callers that only send a percentage keep working, with no points.
  const legacy = db.prepare(`SELECT score, earned_points, max_points FROM progress
    WHERE student_id = ? AND lesson = '1.1' AND activity_type = 'quiz'`).get(students[0].id);
  check('percentage-only rows keep a null denominator',
    legacy.score === 80 && legacy.earned_points === null && legacy.max_points === null, legacy);

  const earnedOverMax = await api('POST', '/api/student/progress', {
    course: 'ap-cybersecurity', unit: 'unit-1', lesson: '1.5', activity_type: 'exercise-2',
    earned_points: 99, max_points: 5,
  }, sAuth(students[0]));
  check('earned is clamped to the maximum',
    earnedOverMax.json.progress.earned_points === 5 && earnedOverMax.json.progress.score === 100,
    earnedOverMax.json.progress);

  const quizPoints = await api('POST', '/api/student/quiz', {
    course: 'ap-cybersecurity', unit: 'unit-2', lesson: '2.1', earned_points: 2, max_points: 5,
  }, sAuth(students[0]));
  check('quiz accepts points instead of a percentage', quizPoints.status === 200, quizPoints.json);
  const quizRow = db.prepare(`SELECT score, earned_points, max_points FROM progress
    WHERE student_id = ? AND lesson = '2.1'`).get(students[0].id);
  check('quiz points stored with derived score',
    quizRow.score === 40 && quizRow.earned_points === 2 && quizRow.max_points === 5, quizRow);

  const noScore = await api('POST', '/api/student/quiz',
    { course: 'ap-cybersecurity', unit: 'unit-2', lesson: '2.2' }, sAuth(students[0]));
  check('quiz still rejects a submission with no result at all', noScore.status === 400, noScore.json);

  const dashPoints = await api('GET', `/api/teacher/classes/${code}/progress`, null, tAuth);
  const cell = dashPoints.json.summary
    .map(s => s.detail?.['unit-1']?.['1.3']?.['lesson']).filter(Boolean)[0];
  check('dashboard exposes the denominator to render 3/4',
    cell.earned_points === 3 && cell.max_points === 4, cell);

  const exportCsv = await api('GET', `/api/teacher/classes/${code}/export`, null, tAuth);
  check('CSV export gained Earned and Possible columns',
    exportCsv.text.split('\n')[0].includes('Earned,Possible'), exportCsv.text.split('\n')[0]);

  console.log('\n── gradebook integration ──');
  const gb = await api('GET', `/api/teacher/classes/${code}/progress`, null, tAuth);
  check('response carries a denominators map', !!gb.json.denominators, Object.keys(gb.json));
  check('denominator keyed lesson|activity', gb.json.denominators['1.3|lesson'] === 4, gb.json.denominators);
  check('ungraded activities are absent, not zero',
    !('1.2|lesson' in gb.json.denominators), gb.json.denominators);
  const gbCell = gb.json.summary.map(s => s.detail?.['unit-1']?.['1.3']?.['lesson']).filter(Boolean)[0];
  check('cell exposes points under the names the gradebook reads',
    gbCell.points_earned === 3 && gbCell.points_possible === 4, gbCell);
  const ungradedCell = gb.json.summary.map(s => s.detail?.['unit-1']?.['1.2']?.['lesson']).filter(Boolean)[0];
  check('an unscored lesson reports a null denominator rather than 100',
    ungradedCell && ungradedCell.points_possible === null, ungradedCell);

  console.log('\n── one grading policy, served to both views ──');
  const teacherView = await api('GET', `/api/teacher/classes/${code}/progress`, null, tAuth);
  const studentView = await api('GET', '/api/student/progress', null, sAuth(students[0]));
  check('teacher view carries the grading policy', !!teacherView.json.grading, Object.keys(teacherView.json));
  check('student view carries the grading policy', !!studentView.json.grading, Object.keys(studentView.json));
  check('both views agree by default',
    JSON.stringify(teacherView.json.grading) === JSON.stringify(studentView.json.grading),
    [teacherView.json.grading, studentView.json.grading]);
  check('mastery defaults to 80', teacherView.json.grading.mastery_threshold === 80, teacherView.json.grading);
  check('lessons excluded from the grade by default',
    teacherView.json.grading.includes_lessons === false, teacherView.json.grading);

  const setPolicy = await api('PUT', `/api/teacher/classes/${code}`,
    { mastery_threshold: 90, grade_includes_lessons: true }, tAuth);
  check('teacher can set the policy', setPolicy.status === 200 && setPolicy.json.grading.mastery_threshold === 90,
    setPolicy.json);

  const studentAfter = await api('GET', '/api/student/progress', null, sAuth(students[0]));
  check('the student view follows the teacher\'s change',
    studentAfter.json.grading.mastery_threshold === 90 && studentAfter.json.grading.includes_lessons === true,
    studentAfter.json.grading);

  const badPolicy = await api('PUT', `/api/teacher/classes/${code}`, { mastery_threshold: 500 }, tAuth);
  check('an out-of-range threshold is rejected', badPolicy.status === 400, badPolicy.json);

  check('student progress carries the same denominators map',
    studentAfter.json.denominators['1.3|lesson'] === 4, studentAfter.json.denominators);
  const stuCell = studentAfter.json.progress.find(r => r.lesson === '1.3' && r.activity_type === 'lesson');
  check('student cells expose points under the names the dashboard reads',
    stuCell.points_earned === 3 && stuCell.points_possible === 4, stuCell);

  // Restore the default so later assertions in this file are unaffected.
  await api('PUT', `/api/teacher/classes/${code}`,
    { mastery_threshold: 80, grade_includes_lessons: false }, tAuth);

  console.log('\n── timestamps are explicit UTC ──');
  const { toIso } = require(path.join(ROOT, 'utils.js'));
  check('space-separated SQLite time gets T and Z',
    toIso('2026-08-05 19:30:00') === '2026-08-05T19:30:00Z', toIso('2026-08-05 19:30:00'));
  check('already-ISO values pass through',
    toIso('2026-08-05T19:30:00.123Z') === '2026-08-05T19:30:00.123Z');
  check('null passes through', toIso(null) === null);

  const clsDetail = await api('GET', `/api/teacher/classes/${code}`, null, tAuth);
  const everyStudentIso = clsDetail.json.students.every(s =>
    (!s.created_at || /Z$/.test(s.created_at)) && (!s.last_active || /Z$/.test(s.last_active)));
  check('class detail returns UTC-marked timestamps', everyStudentIso, clsDetail.json.students);

  const dash = await api('GET', `/api/teacher/classes/${code}/progress`, null, tAuth);
  check('dashboard last_active is UTC-marked',
    dash.json.summary.every(s => !s.student.last_active || /Z$/.test(s.student.last_active)),
    dash.json.summary.map(s => s.student.last_active));

  // The bug this fixes: a bare "YYYY-MM-DD HH:MM:SS" is parsed as local time by
  // the browser, landing in the future for anyone west of UTC.
  const active = dash.json.summary.map(s => s.student.last_active).filter(Boolean)[0];
  check('parsed timestamp is not in the future', new Date(active) <= new Date(Date.now() + 1000), active);

  console.log('\n── admin token unset fails closed ──');
  const saved = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  const closed = await api('GET', '/api/analytics/students', null, ADMIN);
  check('503 when ADMIN_TOKEN unset', closed.status === 503, closed.status);
  process.env.ADMIN_TOKEN = saved;

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
