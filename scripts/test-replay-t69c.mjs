// ─── REPLAY: Will's 08-09 goal row (T69-C) ───────────────────────────────────
// tests/replay/t69c-stale-goal-0809.json is a read-only snapshot of his real
// rows. The 08-09 goal ("Bench 315 goal pushed back past mid-August; will set
// new bench target after maxing out tomorrow ...") has no target date and was
// never superseded, so it stayed a live goal for seven weeks and five weekly
// letters (08-23 to 09-27) quoted it as if it were current. On main nothing ever
// asked about it. On this branch: the review asks about it at the first
// check-in, and a note with "tomorrow" in it cannot be saved without a date.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { activeGoals } from "../src/goals.js";
import { reviewQueue, planReviewOutcomes, REVIEW_ROLLOUT } from "../src/memoryReview.js";
import { validateFact, activeFacts, buildMemoryBlock, estTokens, MEMORY_TOKEN_BUDGET } from "../src/memory.js";
import { planDirectAdd } from "../src/memoryEdit.js";
import { isLegacyCheckinNote } from "../src/memorySections.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(fs.readFileSync(join(here, "../tests/replay/t69c-stale-goal-0809.json"), "utf8"));
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log(`  ✗ ${l}`); } };

const dead = fx.goals.find((g) => /Bench 315 goal pushed back past mid-August/.test(g.goal_text));
const ROLLOUT = Date.parse(REVIEW_ROLLOUT);
const FIRST = new Date(ROLLOUT + 8 * 864e5);          // his first Sunday check-in on this build

console.log("the row, as it is on his account:");
ok(!!dead && !dead.target_date && !dead.superseded_at, "08-09 row: no target date, never superseded");
ok(/maxing out tomorrow/.test(dead.goal_text), "it says 'tomorrow' (Aug 10 was tomorrow)");
ok(activeGoals(fx.goals, FIRST).some((g) => g.id === dead.id), "the readers (activeGoals) still keep it live, exactly as on main: no script touched his goals");
ok(fx.letter_0927.body.includes("Bench 315 by mid-August") && /pushed to fall|pushed/.test(fx.letter_0927.body), "the 09-27 letter quoted the dead goal as current");

console.log("on this branch it is asked about:");
const athlete = { ...fx.athlete };
const q = reviewQueue({ notes: activeFacts(fx.memory, FIRST), goals: fx.goals, athlete, sessions: [], now: FIRST });
const ask = q.items.find((i) => i.older);
ok(ask && ask.ref === dead.id, "at the first check-in the older live goal in the queue IS the 08-09 row");
ok(ask && ask.text.includes("Bench 315 goal pushed back"), "the question quotes it");
ok(q.items.length <= 4, `at most four questions (${q.items.length})`);
const cur = q.items.find((i) => i.merge === "goal");
ok(cur && cur.ref === "w4" || (cur && /Healing left pec/.test(cur.note)), "and the current goal is the 09-06 one");
const targets = q.items.map((i) => ({ rid: i.rid, type: i.type, ref: i.ref, older: !!i.older, asked: true, covered: true }));
const plan = planReviewOutcomes({ targets, verdicts: { [ask.rid]: { verdict: "remove" } }, goals: fx.goals, athlete, now: FIRST });
ok(plan.goalOps.some((o) => o.type === "supersede" && o.id === dead.id), "'not anymore' retires it through the one goal door; the next letter stops quoting it");

console.log("a new note with 'tomorrow' cannot be saved without a date:");
const v = validateFact({ content: "Maxing out bench tomorrow, will set a new target after", kind: "contextual", expires_at: null });
ok(!v.ok && v.reason === "needs_date", "validateFact refuses it");
const typed = planDirectAdd([], "Maxing out bench tomorrow, will set a new target after", FIRST);
ok(!typed.ok && typed.reason === "needs_date", "typed on the tab: refused, with the reason in plain words");
ok(validateFact({ content: "Maxing out bench on Aug 10", kind: "situational", expires_at: new Date(FIRST.getTime() + 864e5).toISOString() }).ok, "with the date and an expiry it saves, and drops by itself");

console.log("his notes, as Joe reads them:");
const act = activeFacts(fx.memory, FIRST);
const summaries = act.filter((r) => isLegacyCheckinNote(r));
ok(summaries.length >= 5, `his account holds ${summaries.length} old check-in summaries`);
const block = buildMemoryBlock(fx.memory, FIRST);
ok(!/Weekly check-in|Monthly check-in/.test(block), "none of them reaches Joe's block any more");
ok(estTokens(block) <= MEMORY_TOKEN_BUDGET + 200, `the block stays inside the budget (${estTokens(block)} tokens)`);

console.log(`\n${fail === 0 ? "✓" : "✗"} replay-t69c: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
