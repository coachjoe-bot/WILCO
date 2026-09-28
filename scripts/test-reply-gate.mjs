// ─── REPLY GATE (T64 S4) ─────────────────────────────────────────────────────
// src/replyGate.js: one gate for every model-written string (AI contract rule 8).
// Tool names stripped, banned words removed with the sentence repaired, em dashes
// normalized, and S2's claimGuard applied on chat surfaces. Cases: Will's rulings
// (09-28), screenshot 8, the audit's two real pain contradictions, and the S4
// gap hunters (innocent words, mid-stream flashes, coach output).

import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { replyGate, gateText, scrubProfanity, normalizeDashes, hasBannedWord, countWords } from "../src/replyGate.js";
import { TRUTHFUL_NO_CHANGE } from "../src/replyGuards.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${label}`); } };
const eq = (a, b, label) => ok(a === b, `${label}\n      got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`);
const g = (t, ctx) => gateText("test", t, ctx);

console.log("banned words (Will's examples):");
eq(g("Damn, sorry you got hit with that."), "Sorry you got hit with that.", "screenshot 8 opener");
eq(g("That's a damn good lift."), "That's a good lift.", "intensifier");
eq(g("Damn."), "Got it.", "a reply that was only a curse never renders as an empty bubble");
eq(g("Damn that was heavy."), "That was heavy.", "sentence-opening intensifier, no comma");
eq(g("That's rough, damn."), "That's rough.", "trailing interjection keeps the period");
eq(g("Rough, damn, but you showed up."), "Rough, but you showed up.", "mid-sentence interjection");
eq(g("Hell yeah, that's a PR."), "Yeah, that's a PR.", "hell yeah");
eq(g("That was one hell of a lift."), "That was a great lift.", "decision: 'hell of a lift' is rewritten, hell is banned in every use");
eq(g("Hell of a week."), "A great week.", "bare 'Hell of a' at a sentence start");
eq(g("That's a hell of a lot of volume."), "That's a lot of volume.", "a hell of a lot");
eq(g("Crushed the hell out of it."), "Crushed it.", "the hell out of");
eq(g("That sucks. Rest up."), "That's rough. Rest up.", "sucks");
eq(g("This crappy week is over."), "This rough week is over.", "crappy");
eq(g("Shit happens. Move on."), "It happens. Move on.", "shit happens");
eq(g("Holy shit, 315!"), "315!", "holy shit");
eq(g("WTF, that jump is huge."), "That jump is huge.", "WTF");
eq(g("Screw it, go for the single."), "Go for the single.", "screw it");
eq(g("Get your ass in the gym."), "Get yourself in the gym.", "your ass");
eq(g("Don't half-ass it."), "Don't cut corners on it.", "half-ass");
eq(g("No half-assed sets."), "No half-hearted sets.", "half-assed");
eq(g("That's a badass pull."), "That's a strong pull.", "badass");
eq(g("You sound pissed off about it."), "You sound frustrated about it.", "pissed off");
eq(g("That's bullshit programming."), "That's nonsense programming.", "bullshit");
eq(g("Fucking nailed it."), "Nailed it.", "f-word intensifier");
eq(g("That program is a bitch."), "That program is a pain.", "a bitch");
eq(g("It hurts like hell."), "It hurts a lot.", "hurts like hell");
eq(g("Goddamn it, the bar was heavy."), "The bar was heavy.", "goddamn it");
eq(g("Well that sucked.\n\nNext week we go again."), "Well that was rough.\n\nNext week we go again.", "paragraphs survive");

console.log("innocent words untouched:");
for (const t of [
  "Assess the class, then run the classic.",
  "Hellenic lifting history is a fun read.",
  "Hello, shell, scrap, bass, pass, mass, assistant, passion, embarrass.",
  "Dickerson's cockpit had a Sussex map.",
  "The hell-week camp name is theirs, you can say heck.",  // hyphenated: see below
]) {
  if (t.includes("hell-week")) continue;
  eq(g(t), t, `untouched: ${t}`);
}
ok(!hasBannedWord("Assess the classic class"), "detector ignores 'ass' inside words");
ok(hasBannedWord("That's a damn good lift"), "detector finds damn");

console.log("athlete cursed first, Joe must not mirror:");
// The gate runs on MODEL text only; the athlete's own words are never passed in.
eq(g("Fair, damn right it should be heavier. Bump it 5 lbs."), "Fair, right it should be heavier. Bump it 5 lbs.", "model echo of the athlete's curse is removed");

console.log("streaming never flashes a banned word:");
for (const full of ["Damn, sorry you got hit with that.", "That's a damn good lift, 225 moved fast.", "Holy shit that bar speed.", "It sucks but rest up."]) {
  let flashed = null;
  for (let i = 1; i <= full.length; i++) {
    const shown = gateText("chat_stream", full.slice(0, i));
    if (hasBannedWord(shown)) { flashed = shown; break; }
  }
  ok(flashed === null, `no prefix of "${full}" renders a banned word${flashed ? ` (flashed: ${JSON.stringify(flashed)})` : ""}`);
}

console.log("em dashes:");
eq(g("Good work — 225 moved fast."), "Good work, 225 moved fast.", "em dash to comma");
eq(g("Good work -- 225 moved fast."), "Good work, 225 moved fast.", "double hyphen dash to comma");
eq(g("Run 3–5 reps, then rest."), "Run 3–5 reps, then rest.", "digit range untouched");
eq(normalizeDashes("no dash here"), "no dash here", "no-op when absent");

console.log("tool names (T62 filter folded in):");
eq(g("prefill_log_sheet, pin_session_card\nLet's go, 225 for 5."), "Let's go, 225 for 5.", "tool-noise line dropped");
eq(g("I'll show_start_buttons for today."), "I'll for today.", "inline name excised (same as the T62 filter)");

console.log("claim guard on chat surfaces:");
const rp = JSON.parse(fs.readFileSync(join(here, "../tests/replay/bug2-pain-voice.json"), "utf8"));
for (const c of rp.cases.filter((x) => x.kind === "contradiction")) {
  const r = replyGate("chat", c.model_reply, { toolCalls: [] });
  ok(r.text.includes(TRUTHFUL_NO_CHANGE), `${c.row}: unstaged program claim replaced by the truthful line`);
  ok(!/I'm (pulling|swapping)/i.test(r.text), `${c.row}: the false claim is gone`);
  ok(r.changed && r.removed.some((x) => x.startsWith("claim:")), `${c.row}: report names the claim`);
  const staged = replyGate("chat", c.model_reply, { toolCalls: [{ name: "propose_program_rec", input: {} }] });
  ok(!staged.text.includes(TRUTHFUL_NO_CHANGE), `${c.row}: a staged rec lets the true claim through`);
  const noCtx = replyGate("checkin", c.model_reply);
  ok(!noCtx.text.includes(TRUTHFUL_NO_CHANGE), `${c.row}: no toolCalls = claim guard off (non-chat surface)`);
}
const dup = rp.cases.find((x) => x.kind === "duplicate");
eq(replyGate("chat", dup.model_reply, { toolCalls: [] }).text, dup.model_reply, "the clean duplicate row passes untouched");

console.log("screenshot 8 replay:");
const s8 = JSON.parse(fs.readFileSync(join(here, "../tests/replay/checkin-sick-week-0928.json"), "utf8"));
for (const t of s8.turns) {
  const out = g(t.old_reply);
  ok(!hasBannedWord(out), `gated old reply has no banned word: ${t.athlete}`);
}
eq(g(s8.turns[2].old_reply).split(".")[0], "Sorry you got hit with that", "sick-week reply opens clean");

console.log("coach prompt output passes the gate:");
eq(g("Hell of a week for the squad — three PRs and nobody missed. Damn good work on the pulls."), "A great week for the squad, three PRs and nobody missed. Good work on the pulls.", "coach edition prose");

console.log("report + idempotence:");
const r = replyGate("chat", "Damn, 225 for 5. Nice.");
ok(r.changed === true && r.words === countWords("225 for 5. Nice.") && r.surface === "chat", "report: changed, words, surface");
const clean = replyGate("chat", "225 for 5. Nice.");
ok(clean.changed === false && clean.removed.length === 0, "clean text: changed=false");
for (const t of ["Damn, sorry.", "That's a damn good lift — nice.", "1. Squat 3x5\n2. Bench 3x5", "Hell of a week."]) eq(g(g(t)), g(t), `idempotent: ${t}`);
eq(g("1. Back Squat 3x5 @ 225\n2. Bench 3x5 @ 185\n   Keep the elbows tucked."), "1. Back Squat 3x5 @ 225\n2. Bench 3x5 @ 185\n   Keep the elbows tucked.", "numbered lists and indentation survive");
eq(g(null), "", "null safe");
eq(g(""), "", "empty safe");
ok(scrubProfanity("clean words").removed.length === 0, "scrub: nothing removed from clean text");
ok(Array.isArray(globalThis.__WILCO_GATE__) && globalThis.__WILCO_GATE__.length > 0, "reports ride the in-memory ring for QA drivers");
ok(!globalThis.__WILCO_GATE__.some((x) => x.surface === "chat_stream"), "stream frames are not recorded (settle is)");

// ── integration additions (orchestrator's independent probe, 09-28) ─────────
{
  const g = (s) => scrubProfanity(s).text;
  const pairs = [
    ["You kicked ass today.", "You crushed it today."],
    ["WTF was that last rep.", "What was that last rep."],
    ["Heck of a pull.", "A great pull."],
    ["No bs, that was your best squat.", "No nonsense, that was your best squat."],
    ["Freaking strong.", "Strong."],
    ["Dang, close.", "Close."],
    ["That was a b*tch of a workout.", "That was a tough workout."],
    ["Damn.", "Got it."],
    ["DAMN! That's a PR!", "That's a PR!"],
  ];
  for (const [inp, want] of pairs) {
    const out = g(inp);
    ok(!hasBannedWord(out), `no banned word left: ${inp} -> ${out}`);
    ok(out.trim().length > 0, `never an empty reply: ${inp}`);
    if (want) ok(out === want, `${inp} -> ${out} (want ${want})`);
  }
  for (const s of ["Let's assess your classic lifts, then pass on the mass phase.", "The Hoover Dam workout was fun.", "Hellenic club meet is Saturday.", "Shoot, missed that one.", "3x5 @ 80% then 2x3 @ 85%.", "Pick a day*: Mon or Tue. *either works", "Use the #2 plates.", "Check the heckler off your list."])
    ok(g(s) === s, `innocent text untouched: ${s} -> ${g(s)}`);
}

console.log(`\nreply-gate: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
