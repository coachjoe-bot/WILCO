// ─── MEMORY REVIEW, SERVER HALF (T69-C, shipped dark) ───
// The queue, the digest question bank and the gateway/DB/toolset twins. The
// full suite (answers, legacy spread) lives with the client in test-memory-review.mjs.
// (header kept from the full suite) ───────────────────────────────────────────────────
// Will 10-01 / 10-02: the weekly check-in removes old information as well as
// adding new. One pure queue decides which notes come up: a 3 to 8 week window
// fixed per note from its id, legacy rows spread over the 8 weeks after rollout,
// four at most, jumpers in a fixed order, never the things that cannot go stale,
// and an answer that stamps, edits, removes or counts.
import {
  reviewQueue, schedule, windowDays, legacyOffsetDays, hashId, logsDisagree, goalLiftIdle, weeklyCounts, planReviewOutcomes, readVerdicts, validateSignupValue,
  REVIEW_MIN_DAYS, REVIEW_MAX_DAYS, MAX_REVIEW_PER_CHECKIN, REVIEW_ROLLOUT,
} from "../src/memoryReview.js";
import { activeFacts } from "../src/memory.js";
import { buildQuestionBank, monthlyExtraQuestions, MEMORY_REVIEW_LIVE } from "../api/_proof.js";
import { TOOLSETS } from "../api/_tools.js";
import { NOTE_SECTIONS } from "../src/memorySections.js";
import { validReviewStamps } from "../api/data.js";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${label}`); } };

const DAY = 864e5;
const ROLLOUT = Date.parse(REVIEW_ROLLOUT);
const at = (ms) => new Date(ms).toISOString();
const NOW = new Date(ROLLOUT + 6 * DAY);                       // the first Sunday check-in after rollout
let n = 0;
const note = (content, over = {}) => ({ id: over.id || `n${++n}`, content, kind: "contextual", status: "active", source: "athlete_said", expires_at: null, section: null, confirmed_at: null, ask_count: 0, created_at: at(ROLLOUT - 40 * DAY), updated_at: at(ROLLOUT - 40 * DAY), ...over });
const goal = (text, over = {}) => ({ id: over.id || `g${++n}`, goal_text: text, target_date: null, superseded_at: null, created_at: at(ROLLOUT - 30 * DAY), confirmed_at: null, ask_count: 0, ...over });
const session = (ago, lifts = ["squat"], now = NOW) => ({ day: new Date(now.getTime() - ago * DAY).toISOString().slice(0, 10), lifts });
const athlete = (over = {}) => ({ created_at: at(ROLLOUT - 90 * DAY), training_days_per_week: null, equipment: null, injury_history: null, review_stamps: null, ...over });
const apply = (rows, actions) => {
  let next = [...rows];
  for (const a of actions) {
    if (a.type === "insert") next = [{ id: `new${++n}`, status: "active", ...a.data }, ...next];
    else next = next.map((r) => (r.id === a.id ? { ...r, ...a.data } : r));
  }
  return next;
};

console.log("the window (3 to 8 weeks, fixed from the id):");
const ws = Array.from({ length: 2000 }, (_, i) => windowDays(`id-${i}`));
ok(Math.min(...ws) === REVIEW_MIN_DAYS && Math.max(...ws) === REVIEW_MAX_DAYS, `every window is ${REVIEW_MIN_DAYS} to ${REVIEW_MAX_DAYS} days and both ends occur`);
ok(windowDays("abc") === windowDays("abc") && legacyOffsetDays("abc") === legacyOffsetDays("abc"), "same id, same day, always");
ok(hashId("a") !== hashId("b"), "ids hash apart");
const spreadDays = new Set(ws).size;
ok(spreadDays >= 30, `the window uses its whole range (${spreadDays} distinct days of 36)`);
const s1 = schedule({ id: "x", stamp: ROLLOUT, created: ROLLOUT - 99 * DAY });
ok(s1.dueAt === ROLLOUT + windowDays("x") * DAY && !s1.legacy, "a stamped note is due its window after the stamp");
const s2 = schedule({ id: "x", stamp: null, created: ROLLOUT - 99 * DAY });
ok(s2.legacy && s2.dueAt >= ROLLOUT && s2.dueAt < ROLLOUT + 57 * DAY && s2.eligibleAt === ROLLOUT, "an unstamped old row is spread across the 8 weeks after rollout");
const s3 = schedule({ id: "x", stamp: null, created: ROLLOUT + 3 * DAY });
ok(!s3.legacy && s3.dueAt === ROLLOUT + 3 * DAY + windowDays("x") * DAY, "an unstamped row written after rollout (an old client) runs from its creation");

console.log("determinism and the cap:");
const many = Array.from({ length: 30 }, (_, i) => note(`Note number ${i} about the athlete`, { id: `m${i}`, confirmed_at: at(NOW.getTime() - 70 * DAY) }));
const q1 = reviewQueue({ notes: many, athlete: athlete(), now: NOW });
const q2 = reviewQueue({ notes: [...many].reverse(), athlete: athlete(), now: NOW });
ok(JSON.stringify(q1.items.map((i) => i.rid)) === JSON.stringify(q2.items.map((i) => i.rid)), "same inputs in any order give the same list");
ok(q1.items.length === MAX_REVIEW_PER_CHECKIN && q1.overflow === 26 && q1.dueCount === 30, `30 due, ${q1.items.length} asked, ${q1.overflow} wait a week`);
ok(q1.items.every((i, k, a) => k === 0 || a[k - 1].overdue >= i.overdue), "most overdue first");

console.log("never asked:");
const never = [
  note("Prefers kg on the barbell lifts", { kind: "pinned", id: "pin" }),
  note("Watching: bench press (pain) reported 2026-09-21", { kind: "situational", expires_at: at(NOW.getTime() + 2 * DAY), id: "watch" }),
  note("Weekly check-in Sep 21: Bodyweight stable at 165 lbs.", { kind: "situational", expires_at: at(NOW.getTime() + 60 * DAY), source: "inferred", id: "sum" }),
  note("Check-in Oct 4. Recovery: dialed.", { section: "this_week", kind: "situational", expires_at: at(NOW.getTime() + 20 * DAY), id: "tw" }),
  note("Away for work", { kind: "situational", expires_at: at(NOW.getTime() + 9 * DAY), id: "away" }),
  note("Meet Nov 14, 2027, 73 kg class", { id: "meet" }),
  note("Exam week Oct 26 to 30, 2027", { id: "exam" }),
  note("Gone note", { status: "deleted", id: "gone" }),
  note("Expired note", { expires_at: at(NOW.getTime() - 3 * DAY), id: "expired" }),
];
const qn = reviewQueue({ notes: never, athlete: athlete(), now: new Date(ROLLOUT + 120 * DAY) });
ok(qn.items.length === 0, `pinned, watch, old summaries, This week, dated and expiring notes are never asked (${qn.items.map((i) => i.ref)})`);
ok(!reviewQueue({ notes: [note("Rehabbing inflamed knees", { id: "ok1" })], athlete: athlete(), now: new Date(ROLLOUT + 120 * DAY) }).items.some((i) => /weight/i.test(i.text)), "bodyweight is never in the list (it is asked every week, outside the cap)");

console.log("jumpers, in order:");
{
  const sessions = [session(2), session(9), session(10), session(16)];   // 1, 1... a thin three weeks
  const a = athlete({ training_days_per_week: 6, equipment: ["Full gym"], injury_history: "Rehabbing inflamed knees and weak core" });
  const gs = [goal("Healing left pec, building up clean and jerk", { id: "gcur", created_at: at(ROLLOUT - 27 * DAY) }), goal("Bench 315 goal pushed back past mid-August; will set new bench target after maxing out tomorrow", { id: "gold", created_at: at(ROLLOUT - 55 * DAY) })];
  const filler = Array.from({ length: 6 }, (_, i) => note(`Filler note ${i}`, { id: `f${i}`, confirmed_at: at(NOW.getTime() - 80 * DAY) }));
  const q = reviewQueue({ notes: filler, goals: gs, athlete: a, sessions, now: NOW });
  const order = q.items.map((i) => `${i.type}:${i.reason}`);
  ok(order[0] === "signup:logs_disagree", `1. a note the logs disagree with leads (${order[0]})`);
  ok(order.slice(1, 3).sort().join() === "goal:goal_no_date,goal:older_goal", `2. then the goal with no date and the older live goal (${order.slice(1, 3)})`);
  ok(order[3] === "signup:never_checked", `3. then a signup field never checked (${order[3]})`);
  ok(q.items.length === 4 && q.overflow >= 1, "cap 4: the rest wait a week");
  const g = q.items.find((i) => i.merge === "goal");
  ok(g && /no date/.test(g.text) && g.text.includes("Healing left pec"), "the current goal's question names the goal and the missing date");
  const old = q.items.find((i) => i.older);
  ok(old && old.text.includes("Bench 315 goal pushed back"), "the older live goal is the 08-09 row, quoted");
  ok(q.items.filter((i) => i.older).length === 1, "never two older goals in one check-in");
  ok(q.items.every((i) => i.tag && i.tag.section && i.tag.label), "every item carries its section and the reason line the athlete sees");
  ok(q.items.every((i) => !/—|–/.test(i.text + i.tag.label)), "no em dashes in what the athlete reads");
  ok(!q.items.some((i) => /not [^.]{1,30}, but /i.test(i.text)), "no 'not X, but Y' in what the athlete reads");
  const t = q.items[0].text;
  ok(/6 days a week/.test(t) && /last three weeks were \d, \d and \d sessions/.test(t), `the question speaks plain numbers: ${t}`);
}

console.log("a jumper still waits out the 3-week minimum:");
{
  const sessions = [session(2), session(12)];
  const mk = (daysAgo) => athlete({ training_days_per_week: 6, review_stamps: { training_days_per_week: { confirmed_at: at(NOW.getTime() - daysAgo * DAY), ask_count: 0 } } });
  ok(reviewQueue({ athlete: mk(10), sessions, now: NOW }).items.length === 0, "checked 10 days ago: not asked again though the logs still disagree");
  ok(reviewQueue({ athlete: mk(22), sessions, now: NOW }).items.some((i) => i.reason === "logs_disagree"), "checked 22 days ago: the jumper fires");
}

console.log("the digest's question bank (server, dark until the flag flips):");
{
  const qb = (memoryReview, over = {}) => buildQuestionBank({ identity: { bodyweight: 165 }, injuries: { active: [], recurring: [] }, volume: null, weekAhead: null, goals: [{ goal: "Healing left pec, building up clean and jerk", target_date: null }], memory: [], memoryReview, ...over }, { ask_weight: true, height_finalized: true }, { now: NOW.getTime() });
  const a = athlete({ training_days_per_week: 6, equipment: ["Full gym"], injury_history: "Rehabbing inflamed knees" });
  const gs = [goal("Healing left pec, building up clean and jerk", { id: "gcur", created_at: at(ROLLOUT - 27 * DAY) }), goal("Bench 315 goal pushed back past mid-August", { id: "gold", created_at: at(ROLLOUT - 55 * DAY) })];
  const rq = reviewQueue({ goals: gs, athlete: a, sessions: [session(2), session(12)], now: NOW });
  const bank = qb({ items: rq.items });
  const goalQs = bank.filter((q) => q.kind === "goal");
  ok(goalQs.length === 1 && goalQs[0].id === "goal", "one goal question, ever: the review's goal rides item 5");
  ok(/no date/.test(goalQs[0].text) && goalQs[0].meta.review && goalQs[0].meta.review.reason === "goal_no_date", "item 5 reads the review's wording and carries its tag");
  const mem = bank.filter((q) => q.kind === "memory");
  ok(mem.length === rq.items.length - 1 && mem.every((q) => q.meta.review && q.meta.review.tag), "every other review item is a memory question with its reason line");
  ok(mem.some((q) => /older goal/.test(q.text)), "the older live goal is asked");
  ok(bank.filter((q) => q.kind === "weight").length === 1, "bodyweight is still asked every week, outside the review");
  ok(mem.length + 1 <= MAX_REVIEW_PER_CHECKIN, "memory questions never exceed the cap");
  const oldBank = qb(undefined, { memory: [{ fact: "Away for work", kind: "situational", expires_at: new Date(NOW.getTime() + 3 * DAY).toISOString(), ageDays: 3 }] });
  ok(oldBank.some((q) => q.id === "memory"), "without a review list the old one-expiring-note question stands (old clients, flag off)");
  ok(!qb({ items: [] }).some((q) => q.id === "memory"), "with a review list the old question is retired");
  const mo = monthlyExtraQuestions({ volume: null, memoryReview: { items: [] }, memory: [{ fact: "Old note", kind: "contextual", ageDays: 90 }] });
  ok(!mo.some((q) => q.id === "memory_stale"), "the monthly 'oldest note' question reads the review: it does not ask a second way");
  ok(MEMORY_REVIEW_LIVE === false, "the server flag ships dark");
}

console.log("twins (the gateway, the DB CHECK, the toolsets):");
{
  const gw = readFileSync(new URL("../api/data.js", import.meta.url), "utf8");
  const mig = readFileSync(new URL("../supabase/migrations/20261003_t69c_context_sections.sql", import.meta.url), "utf8");
  for (const c of ["section", "confirmed_at", "ask_count", "area_key"]) ok(gw.includes(`"${c}"`) && mig.includes(c), `athlete_memory.${c} is in the gateway allowlist and the migration`);
  for (const sec of NOTE_SECTIONS) ok(gw.includes(`"${sec}"`) && mig.includes(`'${sec}'`), `section '${sec}' is in the gateway guard AND the DB CHECK`);
  ok(/review_stamps/.test(gw) && /review_stamps/.test(mig) && /athlete_goals[\s\S]*confirmed_at/.test(mig), "review_stamps and the goal stamps are in the migration; review_stamps is in the gateway");
  ok(validReviewStamps({ equipment: { confirmed_at: "2026-10-04T12:00:00Z", ask_count: 1 } }) && validReviewStamps(null), "valid review stamps pass the gateway guard");
  ok(!validReviewStamps({ pin: { confirmed_at: null } }) && !validReviewStamps({ equipment: { confirmed_at: "x" } }) && !validReviewStamps({ equipment: { ask_count: 99 } }) && !validReviewStamps([]), "unknown fields, bad dates and a runaway counter are refused");
  const v2 = TOOLSETS.mastermind_athlete_v2.find((t) => t.name === "remember_fact"), v3 = TOOLSETS.mastermind_athlete_v3.find((t) => t.name === "remember_fact");
  ok(!v2.input_schema.properties.section && v3.input_schema.properties.section.enum.join() === NOTE_SECTIONS.join(), "section is on the v3 toolset only: v2 (in use) is untouched");
  ok(TOOLSETS.mastermind_athlete_v3.length === TOOLSETS.mastermind_athlete_v2.length, "v3 adds no tool, it extends one");
  ok(/never 'next week'/.test(v3.description) && /expires_at/.test(v3.description), "the tool description teaches the date rule");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
