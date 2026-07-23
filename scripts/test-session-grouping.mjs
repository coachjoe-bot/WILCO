// Session-grouping regression suite — the guard rail for isRealSession +
// groupIntoSessions in src/grit.js.
// Run with: node scripts/test-session-grouping.mjs
//
// This function produces THE number: the workout count on the athlete's header,
// the session count on the coach's roster, the denominator of adherence, and the
// staleness fingerprint that decides whether a parked Quick Log draft is safe to
// resume. It has already ratcheted DOWN once in production (fixed 2026-07-14), so
// the cases that could make a session disappear or split get the most coverage.

import { isRealSession, groupIntoSessions } from "../src/grit.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("  ✗ " + msg); } };
const eq = (got, want, msg) => ok(Object.is(got, want), `${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const HOUR = 60 * 60 * 1000;
let seq = 0;
// created_at drives effectiveDate unless parsed_data.log_date backdates it.
const W = (hoursAgo, extra = {}) => ({
  id: "w" + (++seq),
  athlete_id: extra.athlete_id || "a1",
  created_at: new Date(Date.UTC(2026, 6, 20, 12, 0, 0) - hoursAgo * HOUR).toISOString(),
  parsed_data: { exercises: [{ name: "Back Squat", sets: 5, reps: 5, weight: 315 }], ...(extra.parsed_data || {}) },
  ...(extra.athlete_id ? { athlete_id: extra.athlete_id } : {}),
});
const CHAT = (hoursAgo) => ({ ...W(hoursAgo), parsed_data: { exercises: [], general_notes: "how am I doing?" } });
const RUN = (hoursAgo) => ({ ...W(hoursAgo), parsed_data: { exercises: [], run_data: { distance_miles: 3 } } });

// ── isRealSession ────────────────────────────────────────────────────────────
console.log("isRealSession:");
ok(isRealSession(W(0)), "a row with exercises is a session");
ok(isRealSession(RUN(0)), "a run with no exercises is a session");
ok(!isRealSession(CHAT(0)), "a chat-only row is NOT a session");
ok(!isRealSession({ parsed_data: {} }), "empty parsed_data is not a session");
ok(!isRealSession({ parsed_data: { exercises: [] } }), "empty exercises is not a session");
ok(!isRealSession({}), "no parsed_data is not a session");
ok(!isRealSession(null), "null row is not a session");
ok(!isRealSession(undefined), "undefined row is not a session");

// ── grouping ─────────────────────────────────────────────────────────────────
console.log("groupIntoSessions:");
eq(groupIntoSessions([]).length, 0, "no rows → no sessions");
eq(groupIntoSessions(null).length, 0, "null input → no sessions, not a throw");
eq(groupIntoSessions([CHAT(1), CHAT(2)]).length, 0, "chat-only rows produce no sessions");
eq(groupIntoSessions([W(0)]).length, 1, "one workout → one session");

// The 3h window. Rows inside it are the same gym visit (someone logging lift by
// lift between sets); rows outside it are two visits.
eq(groupIntoSessions([W(0), W(1)]).length, 1, "1h apart = one session");
eq(groupIntoSessions([W(0), W(2.9)]).length, 1, "just inside 3h = one session");
eq(groupIntoSessions([W(0), W(3.1)]).length, 2, "just outside 3h = two sessions");
eq(groupIntoSessions([W(0), W(24)]).length, 2, "a day apart = two sessions");
// Chaining: each row is compared to the PREVIOUS one, not to the session start,
// so a long gym visit logged in 2h steps stays one session.
eq(groupIntoSessions([W(0), W(2), W(4), W(6)]).length, 1, "2h steps chain into one session");

// The explicit answer beats the heuristic. This flag is what the "same workout or
// new session?" chip writes — ignoring it would silently merge two real sessions.
// The flag belongs on the LATER row — it answers "is this new work a new session
// than the one before it", so it's the second entry chronologically that splits.
eq(groupIntoSessions([W(1), W(0, { parsed_data: { new_session: true } })]).length, 2,
   "new_session:true on the later row splits inside the window");
eq(groupIntoSessions([W(1), W(0, { parsed_data: { new_session: false } })]).length, 1,
   "new_session:false leaves the window rule alone");
// It has no effect on the row that already starts a session — nothing to split from.
eq(groupIntoSessions([W(1, { parsed_data: { new_session: true } }), W(0)]).length, 1,
   "new_session:true on the FIRST row of a group is a no-op");

// Chat rows in between must not break a session apart — they're filtered before
// grouping, so they can't act as a time anchor either.
eq(groupIntoSessions([W(0), CHAT(1), W(2)]).length, 1, "a chat row between two logs doesn't split them");

// Per athlete. A coach's roster window holds every athlete's rows in one array;
// grouping across athletes would merge two people's sessions into one.
{
  const rows = [W(0), W(1), W(0, { athlete_id: "a2" }), W(1, { athlete_id: "a2" })];
  const s = groupIntoSessions(rows);
  eq(s.length, 2, "two athletes an hour apart = two sessions, not one");
  ok(s.every(x => x.entries.every(e => e.athlete_id === x.athleteId)), "each session's entries all belong to its athlete");
}

// Input order must not matter — the optimistic history row is PREPENDED to a
// desc-sorted list, and paged-in older rows are appended.
{
  const rows = [W(6), W(0), W(2), W(4)];
  eq(groupIntoSessions(rows).length, 1, "out-of-order input still groups correctly");
  eq(groupIntoSessions([...rows].reverse()).length, 1, "reversed input gives the same answer");
}

// Backdating. log_date is what a "yesterday I did..." message writes; the session
// has to land on the day it happened, not the day it was typed.
{
  const today = W(0);
  const backdated = { ...W(0), parsed_data: { exercises: [{ name: "Bench" }], log_date: "2026-07-17" } };
  eq(groupIntoSessions([today, backdated]).length, 2, "a backdated log is its own session");
}

// Entries are ordered oldest→newest inside a session, which is what the timeline
// card and the "last reply" lookup assume.
{
  const s = groupIntoSessions([W(0), W(1), W(2)])[0];
  eq(s.entries.length, 3, "all three entries land in the session");
  ok(new Date(s.entries[0].created_at) < new Date(s.entries[2].created_at), "entries run oldest → newest");
}

// A custom gap is honoured (the coach analytics path passes its own).
eq(groupIntoSessions([W(0), W(5)], 6 * HOUR).length, 1, "a wider custom gap merges");
eq(groupIntoSessions([W(0), W(2)], 1 * HOUR).length, 2, "a narrower custom gap splits");

if (fail) { console.error(`\n${fail} FAILURE(S) (${pass} passed)`); process.exit(1); }
console.log(`\nAll ${pass} session-grouping checks pass.`);
