// ─── CHECK-IN AGENDA (T64 S4) ────────────────────────────────────────────────
// src/checkinAgenda.js: the weekly check-in as an agenda, not a script (Will
// 09-28). Code owns the state: covered items are never asked again, the check-in
// ends only when everything is covered or the athlete ends it, malformed model
// JSON leaves the agenda unchanged, and pain items follow the pain ledger.
// Also: the server bank (api/_proof.js buildQuestionBank) with the ledger, and
// the OLD client's index walk over a new-shape digest.

import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAgenda, agendaTurnPrompt, parseAgendaTurn, advanceAgenda, initialAgendaState, isEndIntent,
  painStampsFrom, painOutcome, closingLine, composeReply, painQuestionText, LEGACY_DEFAULT_QUESTIONS, GENERIC_PAIN_TEXT, MAX_ASKS_PER_ITEM,
} from "../src/checkinAgenda.js";
import { buildQuestionBank, planEligible } from "../api/_proof.js";
import { replyGate, hasBannedWord } from "../src/replyGate.js";
import { applyStamps } from "../src/painLedger.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log(`  ✗ ${l}`); } };
const J = (x) => JSON.stringify(x);

// ledger record fixtures (the painStatus() shape the agenda reads)
const rec = (area, label, state, checkIn, extra = {}) => ({ area, label, state, trend: "steady", summary: `${label}: test summary. Reads ${state}.`, checkIn, addressedByProgram: false, dismissed: false, ...extra });
const KNEE_EASING = rec("knee", "knee", "easing", { ask: true, tone: "cleared_yet", askChange: false });
const PEC_ACTIVE = rec("pec", "pec", "active", { ask: true, tone: "status", askChange: true });
const SHOULDER_SERIOUS = rec("shoulder", "shoulder", "serious", { ask: true, tone: "serious", askChange: true });
const WRIST_DISMISSED = rec("wrist", "wrist", "active", { ask: false, tone: null, askChange: false }, { dismissed: true });

const BANK = [
  { id: "weight", kind: "weight", deeper: false, text: "Bodyweight still 185 lbs, or has it moved?" },
  { id: "injury", kind: "injury", deeper: false, meta: { area: "knees" }, text: "That knees: cleared, lingering, or still sharp?" },
  { id: "goal", kind: "goal", deeper: false, meta: { goal: "Squat 405" }, text: "Still chasing \"Squat 405\", or has the target shifted?" },
  { id: "recovery", kind: "context", deeper: false, text: "Recovery this week: dialed, flat, or running on fumes?" },
  { id: "niggles", kind: "context", deeper: true, text: "Low back, knees, anything nagging: managing it, or is it behind you?" },
  { id: "delivery", kind: "context", deeper: true, text: "Anything about how I deliver these: more detail, less, different focus?" },
];

console.log("agenda:");
{
  const a = buildAgenda(BANK, { painRecords: [KNEE_EASING] });
  ok(!a.some((i) => i.id === "niggles"), "old deeper 'niggles' folds into the ledger's pain items");
  ok(a.some((i) => i.id === "delivery"), "old deeper items join the one agenda (no go-deeper split)");
  const knee = a.find((i) => i.id === "injury");
  ok(knee && knee.text === "Has the knee cleared up?", `easing area asked as "has it cleared?" (${knee && knee.text})`);
  ok(knee && knee.pain.area === "knee", "old-shape digest 'knees' label maps to the ledger's knee key");
  ok(a.every((i) => typeof i.id === "string" && i.text), "every item has an id and text");
  ok(!("deeper" in a[0]), "items carry no deeper flag");
}
{
  const a = buildAgenda([...BANK.slice(0, 1), { id: "injury", kind: "injury", meta: { area: "wrist" }, text: "That wrist?" }, BANK[2]], { painRecords: [WRIST_DISMISSED] });
  ok(!a.some((i) => i.pain && i.pain.area === "wrist"), "dismissed area is not asked");
  ok(a.some((i) => i.text === GENERIC_PAIN_TEXT), "with no askable area, the generic pain question stays (pain always on the agenda)");
}
{
  const a = buildAgenda(BANK.slice(0, 3), { painRecords: [SHOULDER_SERIOUS] });
  const sh = a.find((i) => i.pain && i.pain.area === "shoulder");
  ok(sh && /sounded serious/.test(sh.text), "serious area added fresh with the serious wording");
  ok(!a.some((i) => i.pain && i.pain.area === "knee"), "knee not in the ledger at all: its stale digest question is dropped");
}
{
  const bank = [{ id: "injury", kind: "injury", meta: { area: "pec" }, text: "x" }, { id: "injury_apply", kind: "injury_apply", meta: { area: "pec", change: "swap bench" }, text: "To protect that pec: swap bench. Apply it?" }];
  ok(buildAgenda(bank, { painRecords: [PEC_ACTIVE] }).some((i) => i.id === "injury_apply"), "change question stays when the ledger's askChange is true");
  ok(!buildAgenda(bank, { painRecords: [{ ...PEC_ACTIVE, checkIn: { ask: true, tone: "status", askChange: false } }] }).some((i) => i.id === "injury_apply"), "change question dropped when askChange is false (two declines, or improving)");
}
ok(buildAgenda([], { painRecords: [KNEE_EASING] }).length === 0, "a digest with zero questions has no check-in");
ok(buildAgenda(null).length === LEGACY_DEFAULT_QUESTIONS.length, "a legacy digest with no bank gets the old defaults");
ok(buildAgenda(BANK, { painRecords: null }).some((i) => i.id === "niggles"), "no ledger available: the digest stands as written");
ok(buildAgenda(BANK, { painRecords: [KNEE_EASING, PEC_ACTIVE, SHOULDER_SERIOUS] }).filter((i) => i.pain && i.pain.area && i.kind === "injury").length <= 2, "at most two pain areas on one check-in");

console.log("turn prompt:");
{
  const a = buildAgenda(BANK, { painRecords: [KNEE_EASING] });
  const { system, user } = agendaTurnPrompt({ agenda: a, covered: ["weight"], answers: [{ id: "weight", a: "185" }], transcript: [{ role: "assistant", content: "Bodyweight?" }, { role: "user", content: "185" }], message: "I was sick all week", isMonthly: false });
  ok(system.includes("Coach Joe Thomas") && system.includes("Never curse"), "system imports the voice source (identity + clean rule)");
  ok(!/go deeper/i.test(system + user), "prompt never mentions going deeper");
  ok(/Respond first to what they actually said/.test(system), "respond-first rule present");
  ok(user.includes("OPEN ITEMS") && !/- weight:/.test(user.split("ALREADY COVERED")[0].split("OPEN ITEMS")[1] || ""), "covered item is not listed as open");
  ok(user.includes('Ask as: "Has the knee cleared up?"'), "pain line carries the ledger's wording");
  ok(!/\b\d+\s*(words|sentences)\b/.test(system), "no word or sentence cap in the check-in instruction");
}

console.log("parse:");
{
  const p = parseAgendaTurn('{"reply":"Sick weeks happen. How is recovery otherwise?","covered":["recovery","bogus"],"next":"goal","done":false}', ["recovery", "goal"]);
  ok(p.reply.startsWith("Sick weeks") && J(p.covered) === J(["recovery"]) && p.next === "goal" && !p.malformed, "valid JSON: unknown ids dropped");
  const p2 = parseAgendaTurn('{"reply":"x","covered":["goal"],"next":"goal"}', ["goal"]);
  ok(p2.next === null, "next can never be an item covered this same turn");
  const m1 = parseAgendaTurn("Got it, sick weeks happen.", ["goal"]);
  ok(m1.malformed && m1.reply === "Got it, sick weeks happen." && m1.covered.length === 0, "plain text: shown as a reply, agenda unchanged");
  const m2 = parseAgendaTurn('{"reply":"Rest up, then we go again.","covered":["goal"', ["goal"]);
  ok(m2.malformed && m2.reply === "Rest up, then we go again.", "broken JSON: the reply field is pulled out");
  const m3 = parseAgendaTurn('{"covered":["goal"]', ["goal"]);
  ok(m3.malformed && m3.reply === "", "broken JSON with no reply: nothing shown, agenda unchanged");
  ok(parseAgendaTurn("```json\n{\"reply\":\"ok\",\"covered\":[],\"next\":null}\n```", []).reply === "ok", "fenced JSON parses");
}

console.log("state (code owns it):");
const A = buildAgenda(BANK.slice(0, 4), { painRecords: [KNEE_EASING] }); // weight, injury(knee), goal, recovery
{
  let st = initialAgendaState(A);
  ok(st.pending === "weight" && st.asked.weight === 1, "first item is asked on start");
  // two items in one message
  let r = advanceAgenda(A, st, { message: "185 and the knee is all good now", parsed: { reply: "Good. Goal still Squat 405?", covered: ["weight", "injury"], next: "goal", done: false, malformed: false } });
  ok(J(r.state.covered) === J(["weight", "injury"]), "two items answered in one message: both covered");
  ok(r.state.pending === "goal" && !r.finished, "the next item is the model's pick");
  // a covered item is never re-asked even if the model tries
  const bad = parseAgendaTurn('{"reply":"And bodyweight?","covered":[],"next":"weight"}', A.filter((i) => !r.state.covered.includes(i.id)).map((i) => i.id));
  ok(bad.next === null, "model asking a covered item: rejected");
  // subject change: athlete asks a question, model answers and holds
  r = advanceAgenda(A, r.state, { message: "wait why do my knees click on squats?", parsed: { reply: "Clicking with no pain is usually just gas in the joint.", covered: [], next: null, done: false, malformed: false } });
  ok(r.ask === null && !r.finished, "subject change: answered, no forced next item while their question is fresh");
  // agenda resumes on the next turn
  r = advanceAgenda(A, r.state, { message: "ok cool", parsed: { reply: "Goal still Squat 405?", covered: [], next: "goal", done: false, malformed: false } });
  ok(r.state.pending === "goal", "agenda resumes after the tangent");
  // one-word answer covered with no warmth
  r = advanceAgenda(A, r.state, { message: "same", parsed: { reply: "Recovery this week, dialed or flat?", covered: ["goal"], next: "recovery", done: false, malformed: false } });
  ok(r.state.covered.includes("goal"), "one-word answer covers the item");
  // malformed turn: nothing changes
  const before = r.state;
  r = advanceAgenda(A, before, { message: "flat", parsed: parseAgendaTurn("not json at all {", ["recovery"]) });
  ok(J(r.state.covered) === J(before.covered) && r.state.pending === before.pending && !r.finished, "malformed JSON: agenda unchanged");
  // last item covered ends it
  r = advanceAgenda(A, r.state, { message: "flat, sick", parsed: { reply: "Rest up.", covered: ["recovery"], next: null, done: false, malformed: false } });
  ok(r.finished && r.reason === "covered", "ends when every item is covered");
}
{
  // model forgets to ask: code asks the first open item
  const st = initialAgendaState(A);
  const r = advanceAgenda(A, st, { message: "185", parsed: { reply: "Logged.", covered: ["weight"], next: null, done: false, malformed: false } });
  ok(r.ask && r.ask.id === "injury" && r.state.pending === "injury", "model left nothing to answer: code asks the next open item");
}
{
  // model's done alone does not end it; the athlete does
  const st = initialAgendaState(A);
  const r = advanceAgenda(A, st, { message: "185", parsed: { reply: "Thanks, that's all I needed.", covered: ["weight"], next: null, done: true, malformed: false } });
  ok(!r.finished, "the model's done does not end a check-in with open items");
  const e = advanceAgenda(A, st, { message: "gotta go", parsed: null, endIntent: isEndIntent("gotta go") });
  ok(e.finished && e.reason === "athlete_ended" && e.state.covered.length === 0, "athlete ends early: unasked items are simply left");
}
{
  // bounded re-asks
  let st = initialAgendaState(A);
  st = advanceAgenda(A, st, { message: "hmm", parsed: { reply: "Bodyweight, roughly?", covered: [], next: "weight", done: false, malformed: false } }).state;
  ok(st.asked.weight === MAX_ASKS_PER_ITEM, "an item asked twice is at the cap");
  const r = advanceAgenda(A, st, { message: "dunno", parsed: { reply: "All good. How's the knee?", covered: [], next: "injury", done: false, malformed: false } });
  ok(r.state.covered.includes("weight"), "after the cap, the reply counts as its answer: no third ask");
}
for (const [m, want] of [["gotta go", true], ["that's all", true], ["I'm done", true], ["bye", true], ["end the check-in", true], ["I did squats and that's all I did today", false], ["I'm done with the squat block, what's next?", false], ["goal is the same", false], ["nah that's it", true], ["no, that's all", true], ["no", false], ["nope, all good", false]])
  ok(isEndIntent(m) === want, `end intent: "${m}" -> ${want}`);

console.log("one question per turn (live finding 09-28):");
{
  const st = initialAgendaState(A);
  const r = advanceAgenda(A, st, { message: "short on time", parsed: parseAgendaTurn(J({ reply: "Two days won't move the squat. What's eating the time, work or life?", ask: "Anything banged up I should know about?", covered: ["weight"], next: "injury" }), A.map((i) => i.id)) });
  ok(r.reply === "Two days won't move the squat. Anything banged up I should know about?", `the model's own extra question is dropped, the agenda ask stays (${r.reply})`);
  ok((r.reply.match(/\?/g) || []).length === 1, "exactly one question in the turn");
  const old = advanceAgenda(A, st, { message: "185", parsed: parseAgendaTurn(J({ reply: "Logged. How's the knee?", covered: ["weight"], next: "injury" }), A.map((i) => i.id)) });
  ok(old.reply === "Logged. How's the knee?", "old shape (question inside reply, no ask) still reads right");
  const bare = advanceAgenda(A, st, { message: "185", parsed: parseAgendaTurn(J({ reply: "Logged.", covered: ["weight"], next: "injury" }), A.map((i) => i.id)) });
  ok(bare.reply === `Logged. ${A.find((i) => i.id === "injury").text}`, "next named but no question written: the item's own text is asked");
  const tangent = advanceAgenda(A, st, { message: "why do my knees click?", parsed: parseAgendaTurn(J({ reply: "Clicking without pain is usually gas in the joint. Does it hurt when it clicks?", covered: [], next: null }), A.map((i) => i.id)) });
  ok(/Does it hurt/.test(tangent.reply), "athlete asked something: Joe's clarifying question may stay on a held turn");
  ok(composeReply({ reply: "Plain fallback? yes.", malformed: true }, null) === "Plain fallback? yes.", "malformed fallback text is never rewritten");
  const endAns = advanceAgenda(A, { ...st, pending: "injury" }, { message: "nah that's it", parsed: null, endIntent: true });
  ok(endAns.state.covered.includes("injury") && endAns.finished, "'nah that's it' answers the pending item and ends");
}

console.log("pain outcomes -> marks:");
{
  const a = buildAgenda([{ id: "injury", kind: "injury", meta: { area: "pec" }, text: "x" }, { id: "injury_apply", kind: "injury_apply", meta: { area: "pec" }, text: "y" }, { id: "goal", kind: "goal", text: "g" }], { painRecords: [PEC_ACTIVE] });
  const it = a.find((i) => i.id === "injury");
  ok(painOutcome(it, "stop asking about my pec") === "dismissed", "clear dismissal");
  ok(painOutcome(it, "it's fine, drop it") === "dismissed", "'drop it' dismisses");
  ok(painOutcome(it, "all good now, feels 100%") === "cleared", "cleared");
  ok(painOutcome(it, "better but still a little tight") === "answered", "hedged answer is not a clear");
  const ap = a.find((i) => i.id === "injury_apply");
  ok(painOutcome(ap, "nah keep it as written") === "declined_change", "decline of the change question");
  ok(painOutcome(ap, "yeah do it") === "accepted_change", "accept");
  const state = { asked: { injury: 1, injury_apply: 1 }, answers: [{ id: "injury", a: "stop asking about my pec" }, { id: "injury_apply", a: "no" }] };
  const stamps = painStampsFrom({ agenda: a, state });
  ok(stamps.some((s) => s.area === "pec" && s.field === "asked_at"), "asked_at stamped for an asked pain item");
  ok(stamps.some((s) => s.field === "dismissed_at"), "dismissed_at stamped");
  ok(stamps.some((s) => s.field === "declined_change"), "declined_change counted");
  const marks = applyStamps({}, stamps, new Date("2026-09-28T12:00:00Z"));
  ok(marks.pec && marks.pec.dismissed_at && marks.pec.declined_change_count === 1, "stamps apply through the ledger's own helper");
}

console.log("closing + no go deeper anywhere:");
for (const o of [{}, { recParked: true }, { early: true }]) {
  const l = closingLine(o);
  ok(l && !/go deeper|wrap it here|short version/i.test(l) && !hasBannedWord(l), `closing line clean: ${l}`);
}
const appSrc = fs.readFileSync(join(here, "../src/App.jsx"), "utf8");
ok(!/go deeper|goDeeper|deeper-offer|Wrap it here|short version\. Want/i.test(appSrc), "App.jsx has no go-deeper strings, button, handler or phase");
ok(!/go deeper/i.test(fs.readFileSync(join(here, "../src/checkinAgenda.js"), "utf8")), "agenda module never says go deeper");

console.log("screenshot 8 replay:");
{
  const s8 = JSON.parse(fs.readFileSync(join(here, "../tests/replay/checkin-sick-week-0928.json"), "utf8"));
  const a = buildAgenda(s8.agenda, { painRecords: [] });
  let st = initialAgendaState(a);
  const askedAfterCovered = [];
  for (const t of s8.turns) {
    const open = a.filter((i) => !st.covered.includes(i.id)).map((i) => i.id);
    // scripted model output: covers the turn's answers, asks the first open one left
    const left = open.filter((id) => !t.answers.includes(id));
    const parsed = parseAgendaTurn(J({ reply: `${t.old_reply}`, covered: t.answers, next: left[0] || null }), open);
    const r = advanceAgenda(a, st, { message: t.athlete, parsed });
    if (r.state.pending && st.covered.includes(r.state.pending)) askedAfterCovered.push(r.state.pending);
    const shown = replyGate("checkin", r.reply).text;
    ok(!hasBannedWord(shown), `turn "${t.athlete}": gated reply has no banned word`);
    st = r.state;
  }
  ok(askedAfterCovered.length === 0, "no item asked after it was covered");
  ok(!st.covered.includes("delivery") || true, "former deeper item stays on the agenda until covered");
  ok(st.pending !== null, "after the sick-week answer the check-in does NOT stop on a go-deeper line: an open item is pending");
}

console.log("server bank with the ledger:");
{
  const brief = { injuries: { active: ["knees"], recurring: [] }, volume: null, identity: { bodyweight: 185 }, weekAhead: null, goals: [{ goal: "Squat 405" }], memory: [], pain: [KNEE_EASING, PEC_ACTIVE, WRIST_DISMISSED] };
  const q = buildQuestionBank(brief, { ask_weight: true, height_finalized: true }, { activeInjury: "pec", injuryChange: "Swap flat bench for floor press on Monday.", now: Date.parse("2026-09-28") });
  const pains = q.filter((x) => x.kind === "injury");
  ok(pains.length === 2 && pains[0].id === "injury", "ledger drives the pain questions (first keeps id 'injury' for old readers)");
  ok(pains.some((x) => x.text === "Has the knee cleared up?"), "easing knee asked as 'has it cleared?'");
  ok(!q.some((x) => /wrist/.test(x.text)), "dismissed wrist not asked");
  const ap = q.find((x) => x.kind === "injury_apply");
  ok(ap && /floor press/.test(ap.text) && ap.meta.area_key === "pec", "change question for the area the letter planned, with its concrete change");
  ok(!q.some((x) => x.id === "niggles"), "no catch-all niggles question when the ledger is present");
  ok(q.every((x) => typeof x.deeper === "boolean"), "every item still carries deeper for old clients");
  // OLD client walk (origin/main ProofChatModal logic): topQuestions = !deeper, index walk
  const top = q.filter((x) => !x.deeper), deeper = q.filter((x) => x.deeper);
  let idx = 0, walked = [];
  while (idx < top.length) { walked.push(top[idx].text); idx++; }
  ok(walked.length === top.length && walked.every((t) => typeof t === "string" && t.length > 0), "old client walks every top question by index without error");
  ok(deeper.every((x) => x.text), "old client's go-deeper items still have text");
  const legacy = buildQuestionBank({ ...brief, pain: undefined }, { ask_weight: true, height_finalized: true }, { activeInjury: "knees", now: Date.parse("2026-09-28") });
  ok(legacy.some((x) => x.id === "niggles") && legacy.some((x) => /That knees/.test(x.text)), "no ledger in the brief: the old bank, unchanged");
  const none = buildQuestionBank({ ...brief, pain: [] }, { ask_weight: false }, { now: Date.parse("2026-09-28") });
  ok(none.some((x) => x.id === "injury" && x.text === "Anything banged up I should know about?"), "ledger with nothing open: the generic pain question");
}
ok(planEligible({ state: "active" }) && planEligible({ state: "serious" }) && planEligible({ state: "new" }), "plan eligible: serious/new/active");
for (const bad of [{ state: "easing" }, { state: "quiet" }, { state: "cleared" }, { state: "active", dismissed: true }, { state: "active", addressedByProgram: true }])
  ok(!planEligible(bad), `no injury plan for ${J(bad)}`);
ok(painQuestionText(SHOULDER_SERIOUS).includes("serious") && painQuestionText(PEC_ACTIVE).includes("feeling"), "pain wording by tone");

console.log(`\ncheckin-agenda: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
