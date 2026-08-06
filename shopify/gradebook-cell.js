/**
 * Gradebook cell formatting.
 *
 * Extracted so every view renders a cell the same way. The rule that matters:
 * never invent a denominator. An activity that reported earned/max points is
 * shown as "3/4"; one that reported only a percentage is shown as "80%"; one
 * that is complete but was never scored — a lesson, typically — is shown as
 * done, not as a score out of 100.
 *
 * Works both as a plain <script> (exposes window.APCSGradebook) and via
 * require() in Node, so the rules can be unit-tested.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.APCSGradebook = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NOT_STARTED = '–';
  const DONE = '✓';
  const STARTED = '·';

  function hasPoints(rec) {
    return rec && Number.isFinite(rec.max_points) && rec.max_points > 0 &&
           Number.isFinite(rec.earned_points);
  }

  function hasScore(rec) {
    return rec && rec.score !== null && rec.score !== undefined && Number.isFinite(Number(rec.score));
  }

  /**
   * @returns {{text: string, pct: number|null, state: string, graded: boolean}}
   *   state is one of: not-started | started | done | scored
   *   pct is null whenever the activity carries no meaningful score, so a
   *   caller can tell "no grade" apart from "a grade of zero".
   */
  function formatCell(rec) {
    if (!rec) return { text: NOT_STARTED, pct: null, state: 'not-started', graded: false };

    if (hasPoints(rec)) {
      const pct = Math.round((rec.earned_points / rec.max_points) * 100);
      return {
        text: rec.earned_points + '/' + rec.max_points,
        pct: pct,
        state: 'scored',
        graded: true,
      };
    }

    if (hasScore(rec)) {
      const pct = Math.round(Number(rec.score));
      return { text: pct + '%', pct: pct, state: 'scored', graded: true };
    }

    // Complete but never scored. This is the lesson case: previously such a
    // cell was rendered against an assumed scale and appeared as "30/100".
    if (rec.completed) return { text: DONE, pct: null, state: 'done', graded: false };

    return { text: STARTED, pct: null, state: 'started', graded: false };
  }

  /** Colour band for a cell, matching the gradebook legend. */
  function band(cell, masteryPct) {
    if (!cell.graded) return cell.state === 'not-started' ? 'none' : 'neutral';
    const mastery = Number.isFinite(masteryPct) ? masteryPct : 80;
    if (cell.pct >= mastery) return 'high';
    if (cell.pct >= 60) return 'mid';
    return 'low';
  }

  /**
   * Aggregates one assignment column.
   *
   * A column whose cells were never scored — a lesson column — reports how many
   * students finished it rather than a percentage, because averaging "done"
   * into a number is what produced a bare "30%" under a Lesson heading.
   *
   * `includeUnstarted` decides whether students who never attempted count as
   * zero. It defaults to false: averaging in twenty students who have not
   * started describes participation, not performance. `participants` and
   * `roster` are always returned so the caller can label whichever it shows.
   */
  function columnAverage(records, options) {
    const opts = options || {};
    const cells = (records || []).map(formatCell);
    const graded = cells.filter(c => c.graded);
    const roster = cells.length;

    if (!graded.length) {
      const done = cells.filter(c => c.state === 'done').length;
      return {
        text: done ? done + ' of ' + roster + ' done' : NOT_STARTED,
        pct: null,
        graded: 0,
        participants: done,
        roster: roster,
        scored: false,
      };
    }

    const counted = opts.includeUnstarted
      ? cells.map(c => (c.graded ? c.pct : 0))
      : graded.map(c => c.pct);
    const pct = Math.round(counted.reduce((a, b) => a + b, 0) / counted.length);

    return {
      text: pct + '%',
      pct: pct,
      graded: graded.length,
      participants: graded.length,
      roster: roster,
      scored: true,
    };
  }

  /**
   * Points total for a student across a row. Ungraded activities contribute
   * nothing to either side, so a lesson can never move the grade — which is
   * already how the existing totals behave.
   */
  function rowTotal(records) {
    let earned = 0, possible = 0, graded = 0;
    for (const rec of records || []) {
      if (hasPoints(rec)) {
        earned += rec.earned_points;
        possible += rec.max_points;
        graded++;
      } else if (hasScore(rec)) {
        // No denominator of its own, so fall back to a hundred-point scale for
        // this one activity only.
        earned += Math.round(Number(rec.score));
        possible += 100;
        graded++;
      }
    }
    return {
      earned: earned,
      possible: possible,
      graded: graded,
      pct: possible ? Math.round((earned / possible) * 100) : null,
    };
  }

  return { formatCell, columnAverage, rowTotal, band };
});
