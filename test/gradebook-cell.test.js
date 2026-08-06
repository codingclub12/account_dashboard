'use strict';
// Unit tests for the gradebook cell rules. No server needed — these are pure
// functions, and the point of extracting them was to be able to pin the
// behaviour that produced "30/100" under a Lesson heading.
const path = require('path');
const { formatCell, columnAverage, rowTotal, band } =
  require(path.join(__dirname, '..', 'shopify', 'gradebook-cell.js'));

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log('  ok   ' + label); }
  else { failures++; console.log('  FAIL ' + label + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
}

console.log('\n── cell formatting ──');

const points = formatCell({ earned_points: 3, max_points: 4, score: 75, completed: true });
check('points render as earned/max', points.text === '3/4', points);
check('points cell reports its percentage', points.pct === 75, points);

const exercise = formatCell({ earned_points: 7, max_points: 7, score: 100 });
check('full marks render as 7/7', exercise.text === '7/7', exercise);

const zero = formatCell({ earned_points: 0, max_points: 8, score: 0 });
check('a zero still renders against its real denominator', zero.text === '0/8', zero);
check('a scored zero counts as graded', zero.graded === true, zero);

const percentOnly = formatCell({ score: 80, completed: true });
check('percentage-only renders as a percentage', percentOnly.text === '80%', percentOnly);

// The regression this whole change exists to prevent.
const lesson = formatCell({ completed: true, score: null, earned_points: null, max_points: null });
check('a completed but unscored lesson renders as done', lesson.text === '✓', lesson);
check('an unscored lesson has no percentage', lesson.pct === null, lesson);
check('an unscored lesson is not graded', lesson.graded === false, lesson);
check('no cell ever renders against an assumed 100',
  ![points, exercise, zero, percentOnly, lesson].some(c => /\/100$/.test(c.text)),
  [points, exercise, zero, percentOnly, lesson].map(c => c.text));

const opened = formatCell({ completed: false });
check('opened but unfinished is distinct from untouched', opened.state === 'started', opened);
check('missing record renders as not started', formatCell(null).text === '–');
check('missing record is not graded', formatCell(null).graded === false);

console.log('\n── colour bands ──');
check('at mastery is high', band(formatCell({ earned_points: 4, max_points: 5 }), 80) === 'high');
check('below mastery but passing is mid', band(formatCell({ score: 65 }), 80) === 'mid');
check('below 60 is low', band(formatCell({ score: 30 }), 80) === 'low');
check('a done lesson gets no grade colour', band(lesson, 80) === 'neutral', band(lesson, 80));
check('an empty cell gets no colour', band(formatCell(null), 80) === 'none');

console.log('\n── column averages ──');

// A lesson column: everyone finished, nobody was scored.
const lessonColumn = columnAverage([
  { completed: true }, { completed: true }, { completed: false }, null,
]);
check('an unscored column reports completions, not a percentage',
  lessonColumn.text === '2 of 4 done', lessonColumn);
check('an unscored column has no percentage', lessonColumn.pct === null, lessonColumn);

const quizColumn = columnAverage([
  { earned_points: 5, max_points: 5 },
  { earned_points: 2, max_points: 5 },
  null, null,
]);
check('a scored column averages only the students who were scored',
  quizColumn.text === '70%', quizColumn);
check('a scored column reports how many were graded', quizColumn.graded === 2, quizColumn);
check('a scored column reports the full roster', quizColumn.roster === 4, quizColumn);

const withZeros = columnAverage([
  { earned_points: 5, max_points: 5 },
  { earned_points: 2, max_points: 5 },
  null, null,
], { includeUnstarted: true });
check('opting in counts non-participants as zero', withZeros.text === '35%', withZeros);

check('an empty column renders as not started', columnAverage([]).text === '–');

console.log('\n── row totals ──');

// The row from the live gradebook: lesson, then three graded activities.
const row = rowTotal([
  { completed: true },                            // lesson, unscored
  { earned_points: 7, max_points: 7 },
  { earned_points: 0, max_points: 8 },
  { earned_points: 2, max_points: 5 },
]);
check('row total matches the gradebook', row.earned === 9 && row.possible === 20, row);
check('row percentage matches the gradebook', row.pct === 45, row);
check('the unscored lesson is excluded from the total', row.graded === 3, row);

const mixed = rowTotal([{ score: 80 }, { earned_points: 2, max_points: 5 }]);
check('a percentage-only activity falls back to a 100-point scale',
  mixed.earned === 82 && mixed.possible === 105, mixed);

check('a row with nothing graded has no percentage', rowTotal([{ completed: true }]).pct === null);
check('an empty row has no percentage', rowTotal([]).pct === null);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
