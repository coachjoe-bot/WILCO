// ─── REPLY GUARDS + ONE-VOICE REPLAY (T64 S2, bug 2) ─────────────────────────
// 1. The per-turn follow-up arbiter (at most one app bubble, priority table).
// 2. claimGuard against the two real prod replies that claimed an unstaged
//    program change, and true claims that must pass untouched.
// 3. The three real bot_reply rows (audit Task 1e) replayed through the new turn:
//    the app posts no pain bubble, exactly one message (Joe's) addresses the
//    pain, no unstaged change survives, memory refuses the founder's tally.
// Run: node scripts/test-reply-guards.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FOLLOWUP_PRIORITY, classifyFollowUp, arbitrateFollowUp, claimGuard, findClaims, TRUTHFUL_NO_CHANGE, painCountGuard, statesPainCount, unitRestateGuard, repWordGuard } from "../src/replyGuards.js";
import { replyGate } from "../src/replyGate.js";
import { ledgerTurn, painFollowUpPlan, withMark, recStagedLine, keepPainRec, ledgerBlock } from "../src/painLedger.js";
import { validateFact, ledgerRejects } from "../src/memory.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ── 1. arbiter ───────────────────────────────────────────────────────────────
{
  ok(FOLLOWUP_PRIORITY.action_done < FOLLOWUP_PRIORITY.choice && FOLLOWUP_PRIORITY.choice < FOLLOWUP_PRIORITY.question && FOLLOWUP_PRIORITY.question < FOLLOWUP_PRIORITY.info, "priority order: action, choice, question, info");
  eq(classifyFollowUp("📋 Added that to your Program tab."), "action_done", "program saved = action");
  eq(classifyFollowUp("✅ Temporary program cleared, back to your regular programming."), "action_done", "temp cleared = action");
  eq(classifyFollowUp(recStagedLine(["knee"])), "action_done", "rec staged line = action");
  eq(classifyFollowUp("You've already got a program saved. Want me to replace it with this one? Tap “Replace program” below"), "choice", "chip offer = choice");
  eq(classifyFollowUp("🔒 Your coach has your program locked, so I can't change it myself, but I can send them a request. Want me to send that to your coach?"), "choice", "locked request = choice");
  eq(classifyFollowUp("One thing before I build off this: does it run for a set stretch?"), "question", "question");
  eq(classifyFollowUp("Couldn't pin it just now, ask me again in a minute."), "info", "info");
  eq(arbitrateFollowUp(null, "info"), "show", "first bubble shows");
  eq(arbitrateFollowUp({ kind: "info" }, "action_done"), "replace", "an action confirmation replaces info");
  eq(arbitrateFollowUp({ kind: "action_done" }, "question"), "drop", "a question behind an action is dropped");
  eq(arbitrateFollowUp({ kind: "choice" }, "choice"), "drop", "equal priority: the first one stands");
  eq(arbitrateFollowUp({ kind: "info" }, "bogus"), "drop", "unknown kind reads as info");
  ok(!/[—]/.test(recStagedLine(["knee", "pec"])), "staged line has no em dash");
  eq(recStagedLine(["knee", "pec"]), "Drafted a program rec for your knee and pec. It's at the bottom of your screen, open it when you're ready.", "staged line copy");
}

// ── 2. claim guard ───────────────────────────────────────────────────────────
const rp = JSON.parse(fs.readFileSync(join(here, "../tests/replay/bug2-pain-voice.json"), "utf8"));
{
  const [founder, wrist, cramp] = rp.cases;
  const g1 = claimGuard(founder.model_reply, { toolCalls: founder.tool_calls });
  ok(g1.changed, "founder Sep 1: unstaged 'pulling front squat' is caught");
  ok(!g1.text.includes("I'm pulling front squat"), "founder: claim removed");
  ok(g1.text.includes(TRUTHFUL_NO_CHANGE), "founder: one truthful line in its place");
  ok(g1.text.includes("Snatch pull at 120kg working weight is solid"), "founder: the rest of the coaching survives");
  eq(g1.text.split(TRUTHFUL_NO_CHANGE).length - 1, 1, "founder: truthful line appears once");
  const g2 = claimGuard(wrist.model_reply, { toolCalls: wrist.tool_calls });
  ok(g2.changed && !g2.text.includes("I'm swapping DB Bench Press"), "849f3ba4 Aug 31: 'I'm swapping DB Bench Press' caught");
  const g3 = claimGuard(cramp.model_reply, { toolCalls: cramp.tool_calls });
  eq(g3.changed, false, "a363f1bb Sep 16: 'isn't ... anything I'm changing your program over' passes (negated)");
  // true claims pass untouched
  const staged = claimGuard(founder.model_reply, { toolCalls: [{ name: "propose_program_rec", input: {} }] });
  eq(staged.changed, false, "a claim with propose_program_rec in the turn passes untouched");
  eq(claimGuard("I've swapped Monday and Tuesday for you.", { appWrites: { program: true } }).changed, false, "a claim with a program write passes");
  // shapes
  ok(claimGuard("I've swapped your Monday bench for floor press.").changed, "'I've swapped' caught");
  ok(claimGuard("I changed your program so Friday is lighter.").changed, "'I changed your program' caught");
  ok(claimGuard("Your program has been updated with a lighter Friday.").changed, "'your program has been updated' caught");
  eq(claimGuard("Want me to swap front squat for box squat this block?").changed, false, "an offer is not a claim");
  eq(claimGuard("I'd pull front squat for a week if it keeps talking.").changed, false, "a conditional is not a claim");
  eq(claimGuard("I'm adding that to your memory so I don't forget.").changed, false, "memory talk is not a program claim");
  eq(claimGuard("I haven't changed anything in your program.").changed, false, "a negation is not a claim");
  eq(claimGuard("Nice work, 120 moved fast. Keep the same plan Friday.").changed, false, "plain coaching passes");
  ok(claimGuard("That's not a training-through-it situation. I'm staging a change to get squat volume off that knee.").changed, "'I'm staging a change' with no rec staged is caught (real-AI pass 09-28)");
  eq(claimGuard("I'm staging a change to get squat volume off that knee.", { toolCalls: [{ name: "propose_program_rec" }] }).changed, false, "'I'm staging a change' passes when the rec really staged");
  eq(findClaims("I'm pulling front squat out of the rotation. I've also swapped dips for push-ups.").length, 2, "two claims found");
  const two = claimGuard("Solid day.\n\nI'm pulling front squat out of the rotation. I've also swapped dips for push-ups for the block.");
  eq(two.text, `Solid day.\n\n${TRUTHFUL_NO_CHANGE}`, "two claims collapse to one truthful line");
}

// ── 2a. S2b item 9: past-tense and decision claims (orchestrator, 09-28) ────
{
  const MUST_REWRITE = [
    "I took front squat out.",
    "I pulled front squat from your program.",
    "I removed dips for now.",
    "I dropped the clean pulls this week.",
    "Let's drop front squats from your program going forward.",
    "I've taken snatch pulls off Thursday.",
    "I cut the dips for now.",
    "I took the dips out of Monday.",
    "We dropped front squat for the rest of the block.",
    "Let's swap bench for floor press this week.",
    "Let's pull front squat out for a week.",
    "I removed the jumps from this block.",
    "I've dropped your squat volume for now.",
    "Front squat's gone. I pulled it for the week.",
    "Good session. I took the clean pulls out, so Tuesday is just front squat.",
  ];
  for (const s of MUST_REWRITE) {
    const g = claimGuard(s, { toolCalls: [], appWrites: {} });
    ok(g.changed && g.text.includes(TRUTHFUL_NO_CHANGE), `rewrite: ${JSON.stringify(s)} (got ${JSON.stringify(g.text)})`);
  }
  const MUST_PASS = [
    "Want me to pull front squat?",
    "I'd pull front squat for a week if it keeps up.",
    "You swapped Monday and Tuesday last week.",
    "Your program already has you off squats until Friday.",
    "Should we drop front squats for a week?",
    "Let's drop front squats for a week?",
    "Let's see how it feels Friday.",
    "Let's keep front squat in and see how the knee does.",
    "You dropped the weight on set 3, smart call.",
    "You took the dips out yourself on Monday, good call.",
    "I took a look at your week 2 numbers and they're climbing.",
    "I pulled up your last three bench sessions.",
    "Your program already takes front squat out this week.",
    "I'd drop the dips for now if they keep bugging you.",
    "If you want, I can take front squat out for a week.",
    "Take the clean pulls out if they bother it, your call.",
    "I haven't taken anything out of your program.",
    "The program took dips out in week 1 already.",
    "Let's go, 120 moved fast.",
    "I dropped a note in your memory about the knee.",
  ];
  for (const s of MUST_PASS) {
    const g = claimGuard(s, { toolCalls: [], appWrites: {} });
    ok(!g.changed, `pass: ${JSON.stringify(s)} (got ${JSON.stringify(g.text)})`);
  }
  // true claims when a rec WAS staged this turn
  for (const s of MUST_REWRITE.slice(0, 5)) {
    eq(claimGuard(s, { toolCalls: [{ name: "propose_program_rec", input: {} }] }).changed, false, `staged rec: ${JSON.stringify(s)} passes`);
    eq(claimGuard(s, { appWrites: { rec: true } }).changed, false, `app-staged rec: ${JSON.stringify(s)} passes`);
  }
}

// ── 2b. Joe's own pain rec reads the ledger (real-AI pass 09-28) ───────────
{
  const none = { areas: ["knee"], verdicts: { knee: "none" }, serious: false };
  eq(keepPainRec(none, "Back squat 3x5 @ 220, stopped after set 2 again, knee was on fire"), false, "verdict none + no ask: Joe's pain rec is dropped");
  eq(keepPainRec({ areas: ["knee"], verdicts: { knee: "offer_change_once" } }, "knee was on fire, stopped"), false, "offer verdict: Joe offers, he does not stage");
  eq(keepPainRec({ areas: ["knee"], verdicts: { knee: "address_now" }, serious: true }, "felt a pop"), true, "address_now: the rec stands");
  eq(keepPainRec(none, "knee is on fire again, can you change my squat day?"), true, "an explicit ask in words: the rec stands");
  eq(keepPainRec(none, "knee flared, can you work around it this week"), true, "'work around it' is an ask");
  eq(keepPainRec({ areas: [], verdicts: {} }, "swap monday and tuesday"), true, "not a pain turn: not the ledger's call");
  eq(keepPainRec(none, "had to take it easy, knee was on fire"), false, "'take it easy' is not an ask");
}

// ── 3. the three real rows through the new turn ─────────────────────────────
{
  const fx = JSON.parse(fs.readFileSync(join(here, "../tests/replay/founder-pain-fixture.json"), "utf8"));
  const before = fx.rows.filter((r) => r.created_at < "2026-09-01");
  const marks = withMark({}, "knee", "offered_at", new Date("2026-08-25T23:00:00-04:00"));
  for (const c of rp.cases) {
    const rows = c.row === "07ea6696" ? before : [];
    const lt = ledgerTurn({ rows, marks: c.row === "07ea6696" ? marks : {}, now: new Date(`${c.date}T16:00:00Z`), tz: fx.tz, message: c.input_message, parsed: { pain_flags: c.parsed_pain_flags } });
    const plan = painFollowUpPlan(lt.turn);
    eq(plan.bubble, null, `${c.row}: the app posts no pain bubble`);
    eq(plan.draftRec, false, `${c.row}: nothing drafted on a non-serious report`);
    const guarded = claimGuard(c.model_reply, { toolCalls: c.tool_calls }).text;
    ok(!guarded.includes(rp.old_app_bubble) && !/one rough day doesn'?t change the plan/i.test(guarded), `${c.row}: no 'one rough day' line`);
    if (c.unstaged_claim) ok(!guarded.includes(c.unstaged_claim), `${c.row}: no unstaged change claimed`);
    ok(/knee|wrist|cramp/i.test(guarded), `${c.row}: Joe's reply is the one message that addresses the pain`);
  }
  // the founder's Sep 1 verdict: already offered Aug 25, worsening -> none (quiet 14 days)
  const lt = ledgerTurn({ rows: before, marks, now: new Date("2026-09-01T12:40:00Z"), tz: fx.tz, message: rp.cases[0].input_message, parsed: { pain_flags: rp.cases[0].parsed_pain_flags } });
  eq(lt.turn.verdicts.knee, "none", "founder Sep 1: no second offer within 14 days");
  eq(lt.records.find((r) => r.area === "knee").mentions, 4, "founder Sep 1: the block's history line counts the 4 mentions BEFORE this message");
  const rec = lt.recordsWithTurn.find((r) => r.area === "knee");
  eq(rec.mentions, 5, "founder Sep 1: the ledger counts 5 real mentions, not Joe's 3");
  const blk = ledgerBlock(lt.records, { turn: lt.turn });
  ok(blk.includes("(This message included.) Verdict for this message: none") && !/\d+ mentions/.test(blk), "block: this message's area shows the picture including it, with its verdict, no counts");
  ok(blk.includes("A program change was already offered Aug 25"), "block: the prior offer is named so 'none' reads as a decision");
  ok(blk.includes("Never say first, second or third time"), "block forbids ordinal counting");
  // serious report: a rec is drafted, the app confirms once after staging
  const ser = ledgerTurn({ rows: [], now: new Date("2026-09-01T16:00:00Z"), message: "felt a pop in my knee and it gave out", parsed: { pain_flags: [{ area: "knee", description: "felt a pop, knee gave out" }] } });
  const sp = painFollowUpPlan(ser.turn);
  eq([ser.turn.verdicts.knee, sp.draftRec, sp.bubble], ["address_now", true, null], "serious: address now, rec drafted, no pain bubble (only the staged confirmation)");
  // memory refuses the founder's tally and the Aug 25 'plan in effect'
  const f = validateFact(rp.cases[0].tool_calls[0].input);
  eq([f.ok, f.reason], [false, "pain_tally"], "remember_fact refuses the founder's 'three times' tally");
  ok(typeof f.toolResult === "string" && f.toolResult.includes("pain ledger"), "refusal names the ledger");
  eq(ledgerRejects("Knees have flagged on squat volume twice in two weeks: Back Squat Aug 22 and Front Squat Aug 25. One-week train-around plan in effect."), "pain_tally", "Aug 25 row refused");
  eq(ledgerRejects("Front squat pulled from the program this block."), "program_claim", "program claim refused");
  eq(ledgerRejects("Swapped DB bench for neutral-grip press in the program."), "program_claim", "swap claim refused");
  eq(ledgerRejects("Rehabbing inflamed knees; deep squats aggravate them."), null, "plain injury context is still saved");
  eq(ledgerRejects("Plans to run Day 1 on Aug 25 (swapped with Day 2)"), null, "a schedule note is not a program claim");
  eq(ledgerRejects("Watching: squat (pain) reported 2026-09-01 - a repeat within 2 weeks earns a program rec"), null, "code watch notes are exempt");
}

// ── verifier BUG-2 (09-29): "setting up" an adjustment with nothing staged ──
{
  const none = { toolCalls: [], appWrites: {} };
  const real = "Smart to stop. I'm setting up a protective adjustment on your squat work so we're not stacking more onto it.";
  const out = claimGuard(real, none);
  ok(out.changed === true && !/setting up/.test(out.text), `the verifier's real reply is rewritten: ${out.text}`);
  ok(/^Smart to stop\./.test(out.text), "the rest of the reply survives");
  for (const s of ["I'm making a small adjustment to your pressing.", "I've lined up a swap for Tuesday.", "I set up a tweak for that."])
    ok(claimGuard(s, none).changed === true, `unstaged claim must be rewritten: ${s}`);
  for (const s of ["Setting up tight under the bar made the difference.", "You made a good adjustment on the second set.", "Want me to set up an adjustment for that?", "Making weight is its own skill."])
    ok(claimGuard(s, none).changed === false, `not a claim, must pass: ${s}`);
}

// ── integration additions (orchestrator's independent probe, 09-28) ─────────
{
  const none = { toolCalls: [], appWrites: {} };
  const staged = { toolCalls: [{ name: "propose_program_rec", input: {} }], appWrites: {} };
  for (const s of ["I staged a rec for that.", "Front squat's out for now.", "Dips are out of the rotation.", "I went ahead and swapped your Tuesday squat for leg press.", "We're pulling front squat this block."])
    ok(claimGuard(s, none).changed === true, `unstaged claim must be rewritten: ${s}`);
  for (const s of ["Your call, but I'd leave it.", "You're out of town for now, so keep it simple.", "Knees are out of the woods.", "That lift is out of your range for now, build to it.", "I staged nothing, the plan stands.", "Want me to pull front squat?"])
    ok(claimGuard(s, none).changed === false, `not a claim, must pass: ${s}`);
  ok(claimGuard("I staged a rec to swap front squat for leg press.", staged).changed === false, "a true claim passes when the rec was staged this turn");
}

// ── 4. T67 turn guards: facts Joe was told not to state ──────────────────────
{
  // pain counts
  for (const s of ["That's the second time that knee's flared up.", "Knee pain twice this week now.", "Third session in a row with that ache.", "That tweak keeps coming up."])
    ok(statesPainCount(s, []), `a pain count is caught: ${s}`);
  ok(statesPainCount("Second time the knee has done that.", ["knee"]), "a ledger area counts as a pain word on its turn");
  for (const s of ["Second session back after the break.", "Two times the bar speed dropped.", "Your second set moved faster.", "Knee felt fine, good.", "That's the second time you've hit 100 this month."])
    ok(!statesPainCount(s, ["knee"]), `not a pain count, must pass: ${s}`);
  const pc = painCountGuard("Right call to stop. That's the second time that knee's flared up, and it's getting worse. Want me to adjust squats?", ["knee"]);
  eq(pc.text, "Right call to stop. Want me to adjust squats?", "the count sentence goes, the rest stays in order");
  eq(painCountGuard("That's the second time the knee flared up.", ["knee"]).changed, false, "a reply is never emptied: nothing else to say, kept whole");
  ok(/^1\. Deadlift/m.test(painCountGuard("Twice now that back has been sore, go light.\n1. Deadlift 3x5\n2. Row 3x8", []).text), "numbered lines keep their line breaks");

  // unit restate
  const u = unitRestateGuard("Logged: Front Squat 3x3 at 225. The app will confirm the unit. Deadlift 3x5 at 130 kg next.", [{ weight: 225 }]);
  ok(!/225/.test(u.text) && /confirm the unit/.test(u.text) && /130 kg/.test(u.text), `the restated flagged load goes (got ${u.text})`);
  eq(unitRestateGuard("Bench 225 moved well. Squat 3x3 at 225 too.", [{ weight: 225 }], [{ name: "Bench Press", weight: 225, unit: "lbs" }]).changed, false, "a number a settled lift also carries is left alone");
  eq(unitRestateGuard("Logged.", []).changed, false, "no pending load, no change");
  eq(unitRestateGuard("Was that 225 in kg or lbs?", [{ weight: 225 }]).changed, false, "Joe's own unit question stays (the app then does not ask again)");
  ok(!/2250|1225/.test(unitRestateGuard("Total 2250 kg moved, 1225 last week.", [{ weight: 225 }]).removed.join(" ")), "digits inside a bigger number are not the load");

  // rep words
  const five3 = [{ name: "Back Squat", set_details: [{ weight: 155, reps: 3 }, { weight: 155, reps: 3 }] }];
  eq(repWordGuard("Two straight jumps on top singles of work.", five3).text, "Two straight jumps on top sets of work.", "singles about triples become sets");
  eq(repWordGuard("A clean double at 100.", five3).text, "A clean set at 100.", "a lone double becomes a set");
  eq(repWordGuard("Solid triples today.", five3).changed, false, "a true rep word stays");
  for (const s of ["Single-leg work next.", "Not a single miss.", "Double-check the bar.", "Triple extension was sharp.", "A single session won't matter.", "Double the rest."])
    eq(repWordGuard(s, five3).changed, false, `not a rep word, must pass: ${s}`);
  eq(repWordGuard("Nice singles.", []).changed, false, "no logged sets, no rewrite");

  // the gate wires them in; no turn = only the pain guard on chat/check-in
  const g = replyGate("chat", "Logged: Front Squat 3x3 at 225. Good work.", { toolCalls: [], turn: { painAreas: [], unitPending: [{ weight: 225 }], performed: [] }, record: false });
  eq(g.text, "Good work.", "gate applies the unit guard with ctx.turn");
  ok(g.removed.some((r) => /^unit_restate:/.test(r)), "gate reports what it removed");
  eq(replyGate("chat", "Logged: Front Squat 3x3 at 225. Good work.", { record: false }).text, "Logged: Front Squat 3x3 at 225. Good work.", "no ctx.turn: the unit guard does not run");
  eq(replyGate("checkin", "Glad it's better. Second time the knee pain eased off.", { record: false }).text, "Glad it's better.", "check-in: pain count removed without a turn");
  eq(replyGate("proof_letter", "Knee pain twice this week.", { record: false }).text, "Knee pain twice this week.", "proof letter: not a conversational surface, untouched");

  // replay: the real replies
  const rp = JSON.parse(fs.readFileSync(join(here, "../tests/replay/t67-log-voice-0929.json"), "utf8"));
  for (const c of rp.cases) {
    const r = replyGate("chat", c.reply, { toolCalls: [], turn: c.turn, record: false });
    eq(r.text !== c.reply, !!c.gate_changes, `replay ${c.id}: gate ${c.gate_changes ? "changes" : "leaves"} the reply`);
    for (const n of c.never || []) ok(!r.text.includes(n), `replay ${c.id}: "${n}" is gone`);
    for (const k of c.keeps || []) ok(r.text.includes(k), `replay ${c.id}: "${k}" stays (got ${r.text})`);
  }
}

console.log(`\n${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
