// ─── GOAL LIFECYCLE + MEMORY-HEALTH QUESTIONS (T62 memory engine) ────────────
// Static truth suite for Will's 09-01 rulings: goals supersede instead of
// accumulating, a dated goal retires 14 days past its target, and the proof
// check-in probes exactly the context that is about to go stale — because the
// check-in is the PRIMARY way athlete context stays current.
import { activeGoals, goalsToSupersede, sameGoalText, GOAL_GRACE_DAYS } from "../src/goals.js";
import { buildQuestionBank, monthlyExtraQuestions } from "../api/_proof.js";

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; } else { fail++; console.log(`  ✗ ${label}`); } };

const NOW = new Date("2026-09-01T12:00:00Z");
const day = 864e5;
const iso = (d) => new Date(d).toISOString();

// ── activeGoals ──────────────────────────────────────────────────────────────
console.log("activeGoals:");
const g = (over = {}) => ({ id: over.id || "g1", goal_text: "Bench 315", ...over });
ok(activeGoals([g()], NOW).length === 1, "plain goal is active");
ok(activeGoals([g({ superseded_at: iso(NOW - day) })], NOW).length === 0, "superseded goal is out");
ok(activeGoals([g({ target_date: "2026-08-15" })], NOW).length === 0, "goal >14 days past target retires (the bench-315-by-mid-August case)");
ok(activeGoals([g({ target_date: iso(NOW.getTime() - (GOAL_GRACE_DAYS - 2) * day) })], NOW).length === 1, "goal inside the grace window survives");
ok(activeGoals([g({ target_date: iso(NOW.getTime() + 30 * day) })], NOW).length === 1, "future-dated goal is active");
ok(activeGoals([g({ goal_text: "  " })], NOW).length === 0, "blank goal text never injects");
ok(activeGoals([g({ target_date: "not-a-date" })], NOW).length === 1, "unparseable target_date is ignored, goal stays");

// ── goalsToSupersede ─────────────────────────────────────────────────────────
console.log("goalsToSupersede:");
const rows = [
  g({ id: "new", created_at: "2026-09-01" }),
  g({ id: "old", goal_text: "Squat 405", created_at: "2026-08-01" }),
  g({ id: "stale", goal_text: "Bench 315 by mid-August", target_date: "2026-08-15", created_at: "2026-05-31" }),
  g({ id: "done", goal_text: "Ancient", superseded_at: iso(NOW - 30 * day) }),
];
const sup = goalsToSupersede(rows, "new", NOW).map((x) => x.id);
ok(sup.includes("old"), "prior active goal gets superseded");
ok(!sup.includes("new"), "the new row is never self-superseded");
ok(!sup.includes("stale"), "stale-by-date rows are left alone (their lapse date is truth)");
ok(!sup.includes("done"), "already-superseded rows are not re-stamped");

// ── sameGoalText ─────────────────────────────────────────────────────────────
ok(sameGoalText("Bench 315 by December!", "bench 315 by december"), "restatement detected across case/punctuation");
ok(!sameGoalText("Bench 315", "Bench 335"), "different targets are different goals");
ok(!sameGoalText("", ""), "empty never matches empty");

// ── question bank: goal-date + memory-refresh ────────────────────────────────
console.log("question bank:");
const brief = (over = {}) => ({
  identity: { bodyweight: 185 },
  injuries: { active: [], recurring: [] },
  volume: null,
  weekAhead: null,
  goals: [],
  memory: [],
  ...over,
});
const ath = { ask_weight: false, height_finalized: true };

// buildQuestionBank's goal-date and memory-expiry checks are date-relative
// (days between target_date/expires_at and "now"); pin `now` to NOW so this
// suite stays deterministic instead of drifting as real wall-clock time
// passes it (caught during the T64 W0 base-branch build, real Date.now() had
// walked 27 days past this branch's 09-01 write date and flipped the
// near-dated case into the past-dated one).
const nowOpt = { now: NOW.getTime() };
let q = buildQuestionBank(brief({ goals: [{ goal: "Bench 315", target_date: "2026-08-20" }] }), ath, nowOpt);
let goalQ = q.find((x) => x.id === "goal");
ok(goalQ && /dated Aug 20/.test(goalQ.text) && /Did you get it/.test(goalQ.text), "past-dated goal asks the got-it/move-it/new-target question");
q = buildQuestionBank(brief({ goals: [{ goal: "Bench 315", target_date: iso(NOW.getTime() + 10 * day).slice(0, 10) }] }), ath, nowOpt);
goalQ = q.find((x) => x.id === "goal");
ok(goalQ && /On track, moving the date, or changing the target/.test(goalQ.text), "near-dated goal names the date and asks for a call");
q = buildQuestionBank(brief({ goals: [{ goal: "Bench 315", target_date: iso(NOW.getTime() + 90 * day).slice(0, 10) }] }), ath, nowOpt);
goalQ = q.find((x) => x.id === "goal");
ok(goalQ && /Still chasing/.test(goalQ.text), "far-dated goal keeps the plain still-chasing question");

const expSoon = { fact: "Traveling for finals week, hotel gym only", kind: "situational", expires_at: iso(NOW.getTime() + 4 * day), ageDays: 3 };
const expFar = { fact: "Off squats till October", kind: "situational", expires_at: iso(NOW.getTime() + 40 * day), ageDays: 3 };
const watch = { fact: "Watching: knee (pain) reported 2026-08-25", kind: "situational", expires_at: iso(NOW.getTime() + 2 * day), ageDays: 7 };
q = buildQuestionBank(brief({ memory: [expFar, expSoon, watch] }), ath, nowOpt);
const memQ = q.filter((x) => x.kind === "memory");
ok(memQ.length === 1, "exactly one memory-refresh question per weekly bank");
ok(/hotel gym only/.test(memQ[0].text), "the soonest-expiring note is the one probed");
ok(!q.some((x) => x.kind === "memory" && /Watching:/.test(x.text)), "Watching notes never surface here (rec gate owns them)");
q = buildQuestionBank(brief({ memory: [expFar] }), ath, nowOpt);
ok(!q.some((x) => x.kind === "memory"), "nothing near expiry, no memory question");

const staleFact = { fact: "Trains at the campus rec center", kind: "contextual", expires_at: null, ageDays: 90 };
const freshFact = { fact: "Prefers morning sessions", kind: "contextual", expires_at: null, ageDays: 10 };
let mq = monthlyExtraQuestions(brief({ memory: [freshFact, staleFact] }));
ok(mq.some((x) => x.id === "memory_stale" && /campus rec center/.test(x.text)), "monthly re-confirms the oldest long-lived note");
mq = monthlyExtraQuestions(brief({ memory: [freshFact] }));
ok(!mq.some((x) => x.id === "memory_stale"), "young context is left alone monthly");

console.log(`\ngoals: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
