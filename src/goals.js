// ─── GOAL LIFECYCLE (T62 memory engine, Will's 09-01 ruling) ─────────────────
// athlete_goals was insert-only: a revised goal wrote a NEW row, nothing ever
// superseded or expired one, and the prompt injected the newest three side by
// side — which is exactly how "bench 315 by mid-August" was still steering Joe
// in September, next to the goal that replaced it. The rules now:
//   • writing a new goal SUPERSEDES the prior active rows (superseded_at stamp;
//     history stays in the table for the coach brain and Past Blocks);
//   • a goal with a target_date quietly retires GOAL_GRACE_DAYS after that date
//     passes — ideally the athlete re-states it first (check-in, a new program
//     build, or chat) and supersession does the work instead;
//   • every reader — the chat prompt, the Memory tab, the proof brief, the crew
//     glance — filters through activeGoals so no surface resurrects a dead goal.
// Pure logic only (unit-tested in scripts/test-goals.mjs); the gateway writes
// live with the callers.

export const GOAL_GRACE_DAYS = 14;

// Active = not superseded, and not past its own target date by more than the
// grace window. Rows are athlete_goals records; tolerant of partial shapes.
export function activeGoals(rows, now = new Date()) {
  const t = now.getTime();
  return (rows || []).filter((g) => {
    if (!g || !String(g.goal_text || "").trim()) return false;
    if (g.superseded_at) return false;
    if (g.target_date) {
      const d = Date.parse(g.target_date);
      if (Number.isFinite(d) && t > d + GOAL_GRACE_DAYS * 86400000) return false;
    }
    return true;
  });
}

// The rows a new goal write should stamp as superseded: every currently-active
// row except the new one. (Stale-by-date rows are left alone — they are already
// invisible to every reader, and stamping them would erase WHEN they lapsed.)
export function goalsToSupersede(rows, keepId, now = new Date()) {
  return activeGoals(rows, now).filter((g) => String(g.id) !== String(keepId));
}

// Is this goal text just a restatement of an existing active goal? Used to skip
// a supersede-and-rewrite when the Builder applies a program whose blueprint
// goal matches what's already on file.
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
export function sameGoalText(a, b) {
  const na = norm(a), nb = norm(b);
  return !!na && na === nb;
}

// T69-A (10-02): a goal that was JUST stated never targets the past. The goal
// parser (parseAthleteGoal, a small model) resolves "by December" to a full
// date, and it was never told what today is: on 2026-10-02 it stamped
// 2024-12-31 on "bench 315 by December", 5 of 5 runs. activeGoals then retired
// the goal the athlete had just set and it vanished from the Memory tab and
// from Joe's context on the next load. The year is a fact, so code owns it: a
// parsed date that is already behind is rolled to the next time that month and
// day come. Returns a plain YYYY-MM-DD, or null when there is no usable date.
export function futureGoalDate(dateStr, now = new Date()) {
  const m = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const mo = +m[2] - 1, d = +m[3];
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let y = +m[1];
  if (Date.UTC(y, mo, d) < today) {
    y = now.getUTCFullYear();
    if (Date.UTC(y, mo, d) < today) y += 1;
  }
  const out = new Date(Date.UTC(y, mo, d));
  return Number.isNaN(out.getTime()) ? null : out.toISOString().slice(0, 10);
}
