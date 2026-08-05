# APCSExamPrep Progress API

Student progress tracking system for APCSExamPrep.com.
Supports AP Cybersecurity, AP CSA, AP CSP.

## Architecture

- **Backend**: Node.js + Express + SQLite (Railway)
- **Frontend**: Vanilla JS pages on Shopify
- **Auth**: JWT (teachers) + long-lived JWT session tokens (students)
- **Database**: SQLite via better-sqlite3 (upgrade to Postgres when needed)

## Deployment: Railway

### Step 1 — Create Railway project

1. Go to railway.app → New Project
2. Deploy from GitHub (push this folder to a repo first)
   OR use the Railway CLI: `railway deploy`
3. Railway auto-detects Node.js from package.json

### Step 2 — Set environment variables in Railway

Go to your Railway project → Variables → Add:

```
JWT_SECRET=<generate a long random string - at least 64 chars>
DB_PATH=/data/progress.db
PORT=4000
ADMIN_TOKEN=<random string; gates /api/analytics/*>
ANALYTICS_SALT=<random string; salts hashed IDs in the export>
COMPLETION_FIX_DATE=<YYYY-MM-DD you deploy the engagement-threshold tracker>
EVENT_RETENTION_DAYS=180
```

`ADMIN_TOKEN` and `ANALYTICS_SALT` are optional but the analytics export is
unreachable without the first, and falls back to `JWT_SECRET` for the second.
See [Analytics Notes](#analytics-notes).

To generate a JWT_SECRET:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### Step 3 — Add persistent volume for SQLite

In Railway: Service → Volumes → Add Volume
- Mount path: `/data`
- This ensures the SQLite database survives deployments

### Step 4 — Get your Railway URL

Railway gives you a URL like: `https://progress-api-production-xxxx.up.railway.app`

Update the `API` constant in all Shopify HTML files:
```javascript
const API = 'https://YOUR-RAILWAY-URL.railway.app';
```

Optionally set up a custom subdomain: `progress.apcsexamprep.com`
via Cloudflare → DNS → CNAME → your Railway URL

### Step 5 — Deploy Shopify pages

Create four new Shopify pages with handle = exact URL slug.
Paste the HTML from shopify/ into the page body (template: page.blank).

| File | Shopify Handle |
|------|---------------|
| shopify/join.html | join |
| shopify/my-progress.html | my-progress |
| shopify/cyber-class.html | cyber-class |
| shopify/cyber-dashboard.html | cyber-dashboard |

### Step 6 — Add tracker.js to your theme

1. Upload `shopify/apcs-tracker.js` to Shopify theme → Assets as `apcs-tracker.js`
2. On each lesson/exercise/quiz page, add before the closing `</body>`:

```html
<script>
window.APCS_PAGE = {
  course: 'ap-cybersecurity',
  unit: 'unit-1',
  lesson: '1.1',
  activity: 'lesson', // or exercise-1, exercise-2, quiz
};
</script>
<script src="{{ 'apcs-tracker.js' | asset_url }}"></script>
```

### Step 7 — Integrate quiz scoring

On each quiz page, after the student submits their final score, call:

```javascript
// When student completes quiz and you have their score (0-100):
if (window.APCS_saveQuizScore) {
  await window.APCS_saveQuizScore(score, { q1: 'C', q2: 'B' });
}
```

## API Endpoints

### Public
```
GET  /api/health                    Health check
GET  /api/class/:code/exists        Validate class code
```

### Teacher Auth
```
POST /api/teacher/register          { email, password, name, school }
POST /api/teacher/login             { email, password }
GET  /api/teacher/me                Get teacher profile (auth required)
```

### Teacher Class Management (auth required)
```
GET  /api/teacher/classes           List all classes
POST /api/teacher/classes           Create class { class_name, course }
GET  /api/teacher/classes/:code     Class details + student list
GET  /api/teacher/classes/:code/progress   Full dashboard data
GET  /api/teacher/classes/:code/export     CSV download
PUT  /api/teacher/classes/:code     Update class { class_name, active }
DELETE /api/teacher/classes/:code/students/:id  Remove student
```

### Student Auth
```
POST /api/student/join              { class_code, display_name, pin }
POST /api/student/login             { class_code, display_name, pin }
```

### Student Progress (auth required)
```
GET  /api/student/me                Student profile + class info
GET  /api/student/progress          All progress records
POST /api/student/progress          Save/update progress record
POST /api/student/quiz              Submit quiz attempt with score
```

Both accept a result as either a bare `score` (0-100) or `earned_points` with
`max_points`. See [Points and denominators](#points-and-denominators).

### Event Ingest (public)
```
POST /api/events                    Batch of analytics events
```

Accepts unauthenticated calls — most site traffic is signed out. A student
`Authorization: Bearer` header is optional and links the session to a student
when present. See [Event Log](#event-log).

### Analytics Export (ADMIN_TOKEN required)
```
GET  /api/analytics/students        One row per student, hashed IDs
GET  /api/analytics/class-days      Class × day activity
GET  /api/analytics/teacher-funnel  Adoption funnel + per-teacher stall point
GET  /api/analytics/assessment      CFU / quiz / exercise / lab broken out
GET  /api/analytics/funnel          Enrolled → opened → completed → attempted → passed
GET  /api/analytics/retention       Day 1, day 7, week 2, multi-day cohorts
GET  /api/analytics/traffic         Sessions, visitors, page views, active minutes per day
GET  /api/analytics/acquisition     Channel, referrers, campaigns, new vs returning
GET  /api/analytics/devices         Device, browser, OS, country
GET  /api/analytics/journeys        Most common event sequences per session
GET  /api/analytics/summary         All of the above in one JSON payload
```

Bot sessions are excluded from the traffic-derived endpoints. Pass
`?include_bots=1` to keep them.

All tabular endpoints accept `?format=csv`. All accept `?days=N` or
`?from=YYYY-MM-DD&to=YYYY-MM-DD` (default: last 30 days).

Authenticate with `Authorization: Bearer $ADMIN_TOKEN` or `?token=`:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://progress.apcsexamprep.com/api/analytics/summary?days=30"
```

## Analytics Notes

**Identifiers are hashed.** Student, teacher, and class IDs are salted SHA-256
prefixes. Names, emails, and class codes are never exported — a class code is a
live join credential, so it is treated as a secret. Hashes are stable across
exports as long as `ANALYTICS_SALT` doesn't change, so rows can be joined
between two downloads.

**"Completed" changed meaning.** `apcs-tracker.js` used to fire
`completed: true` on page load, which made "opened a lesson page" and
"completed a lesson" the same number. It now records the open as
`completed: false` and only marks completion after 60 seconds of active time
and 70% scroll depth (tunable per page via `window.APCS_PAGE.min_seconds` and
`min_scroll_pct`). Rows written before that change still mean "opened" — set
`COMPLETION_FIX_DATE` to the deploy date and `/api/analytics/funnel` will report
the two populations separately instead of mixing them.

**Active-day counts are a lower bound.** `progress` rows are updated in place
and `students.last_active` is overwritten, so only `quiz_attempts` is truly
append-only. Anything counting distinct active days — including the retention
windows — is a floor, and those fields are suffixed `_min`.

## Points and denominators

`progress.score` is a bare 0-100 percentage. On its own it forces anything
rendering a gradebook cell to invent a scale: activities with a known question
count came out as `2/5`, and everything else — lessons in particular — fell back
to `30/100`, which reads as a grade on a hundred-point scale rather than what it
actually is.

Activities can now report `earned_points` and `max_points` alongside or instead
of `score`:

```javascript
// A four-checkpoint lesson
window.APCS_savePoints(3, 4);        // stored as 3/4, score derived as 75

// A quiz, with its real question count
window.APCS_saveQuizScore(40, answers, { earned: 2, max: 5 });
```

Rules:

- Points win. When both are sent, `score` is derived from the points, so the
  two can never disagree.
- `earned_points` is clamped to `max_points`.
- Callers that only send `score` keep working unchanged; their points stay null.
- Consumers should render `earned/max` when both are present and fall back to
  the percentage otherwise — never assume a denominator of 100.

`GET /api/teacher/classes/:code/progress` returns both on every cell in
`detail`, and the CSV export gained `Earned` and `Possible` columns.

### Rendering a cell

`shopify/gradebook-cell.js` implements these rules once so every view agrees.
It loads as a plain `<script>` (exposing `window.APCSGradebook`) or via
`require()` in Node, and is unit-tested in `test/gradebook-cell.test.js`.

```javascript
APCSGradebook.formatCell({ earned_points: 3, max_points: 4 });  // "3/4"
APCSGradebook.formatCell({ score: 80 });                        // "80%"
APCSGradebook.formatCell({ completed: true });                  // "✓"  — not "/100"
APCSGradebook.formatCell(null);                                 // "–"
```

`columnAverage(records)` aggregates one assignment. A column whose cells were
never scored reports `"2 of 4 done"` rather than a percentage, because averaging
"done" into a number is what produced a bare `30%` under a Lesson heading. It
excludes students who never attempted by default and returns `graded`,
`participants`, and `roster` so the caller can label whichever it shows.

`rowTotal(records)` sums a student's points. Ungraded activities contribute to
neither side, so a lesson can never move the grade.

## Event Log

`sessions` and `events` are the only append-only tables in the schema.
Everything else records *state* — a progress row is overwritten each time a
student touches an activity — so this is what makes sessions, acquisition,
device mix, and journey reconstruction possible.

**Anonymous visitors are tracked too.** `student_id` is nullable on purpose.
Organic search readers, a link shared into a Teams channel, a teacher previewing
a lesson — none of them are signed in, and they are exactly the population the
acquisition questions are about.

**No IP address and no raw user agent is ever stored.** Only the derived device
family, browser family, OS family, and (when the edge provides it) a two-letter
country code. School students use this site; a UA string plus an IP is a
fingerprint. See `lib/enrich.js`.

**The ingest endpoint is public, so it defends itself:** a strict event-type
whitelist, a 50-event batch cap, string length caps, timestamps clamped to a
sane window, and per-IP and per-session rate limits.

**Bot traffic is flagged at ingest**, not filtered downstream, and excluded from
every traffic-derived endpoint by default.

### Retention

Raw events are kept for `EVENT_RETENTION_DAYS` (default 180) so any metric can
be re-derived later, including ones nobody has thought of yet. Past that they
are rolled into `event_daily` — kept forever — and deleted. The rollup runs at
boot and every 24 hours. Journeys and session-level detail are unavailable
before the retention horizon; daily totals go back indefinitely.

### Linking to Clarity

The tracker writes its identifiers into Clarity as custom tags:

```javascript
clarity('set', 'apcs_session', <session_id>);
clarity('set', 'apcs_visitor', <visitor_id>);
```

Without this, Clarity can show a 25-minute visit and the app can show a
completion with no way to confirm they were the same journey. With it, either
side can be filtered by the other's identifier.

### Site-wide deployment

To capture signed-out traffic, `apcs-tracker.js` must load on **every** page,
not just lesson pages. It no longer requires `window.APCS_PAGE` — without it the
script records page views, sessions, and active time, and skips progress
tracking entirely.

For pages that grade individual items (CFUs, code exercises), call:

```javascript
window.APCS_trackItem('1.4-cfu-3', 80, true, 2); // itemId, score, passed, attemptNo
```

## Tests

```bash
npm test
```

Two suites, both booting the real app against a throwaway SQLite database:

- `test/analytics.test.js` — migrations, engagement thresholds, time
  accumulation, the progress-derived analytics endpoints, admin auth, and that
  no names, emails, or class codes appear in the export.
- `test/events.test.js` — ingest validation and defences, session derivation,
  channel classification, bot flagging, the traffic endpoints, and that the
  retention rollup neither loses nor double-counts.

## Local Development

```bash
cd progress-api
cp .env.example .env
# Edit .env with your JWT_SECRET
node server.js
# API runs at http://localhost:4000
```

## Adding More Courses

The schema and COURSES config in `utils.js` supports all three courses.
To add CSA or CSP lessons, update the `COURSES` object in `utils.js`
and the `COURSE_MAP` in `shopify/my-progress.html`.

## Scaling to Postgres

When SQLite isn't enough (hundreds of concurrent teachers):
1. Add Railway Postgres service
2. Replace `better-sqlite3` with `pg` or `knex`
3. Port schema to Postgres DDL (SERIAL instead of TEXT for IDs, etc.)

SQLite can handle thousands of students easily for V1.
