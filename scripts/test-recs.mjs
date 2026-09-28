// ─── PROGRAM RECS SUITE ───────────────────────────────────────────────────────
// Locks the staged-program-change contract (Will's 08-28 design):
//   1. Swap location is week/day aware and refuses ambiguity — the same line in
//      weeks 2 and 3 is never guessed at.
//   2. Apply is deterministic and all-or-nothing: byte-for-byte what was
//      approved, nothing outside the named text moves, half-fits refuse.
//   3. Revert restores originals and skips hand-edited lines.
//   4. Durations are the hard set only (1/2/3 weeks, block; no permanent).
//   5. The pattern gate: first mention = watched note; a Rec needs a repeat on
//      a different day, severity, or an explicit ask.
// Run: node scripts/test-recs.mjs
import {
  parseProgramLines, locateSwap, locateSwaps, applySwaps, revertSwaps,
  REC_DURATIONS, durationLabel, recExpiry, recExpired,
  buildWatchNote, watchHit, watchTopic, topicTokens, isSevereReport, validateRecPayload,
  recSummaryFallback,
} from "../src/recs.js";

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.error(`✗ ${name}`); } };
const eq = (a, b, name) => ok(a === b, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// Will's real program shape: whole day on one line, week headers.
const PROG = [
  "BLOCK 1 — ROAD TO 315",
  "RULES No RPE. If the pec talks, the set is over.",
  "WEEK 1 — Aug 17 to Aug 22",
  "Monday Front squat 4x3 at 250 Snatch pull 4x3 at 240 Back extensions 3x12",
  "Tuesday Bench 5x2 at 200 Dips 3x6 bodyweight",
  "Saturday Deadlift 4x4 at 270 Recovery bench 3x5 at 140, controlled, full range",
  "WEEK 2 — Aug 24 to Aug 29",
  "Monday Front squat 4x3 at 270 Snatch pull 4x3 at 250 Back extensions 3x12",
  "Saturday Deadlift 4x4 at 290 Recovery bench 3x5 at 140",
  "WEEK 3 — Aug 31 to Sep 5",
  "Saturday Deadlift 4x3 at 310 Recovery bench 3x5 at 140",
].join("\n");

// Day-header format (the other shape in the wild).
const PROG2 = [
  "Day 1 – Push",
  "Bench Press 3x5 @ 185",
  "Overhead Press 3x8 @ 95",
  "",
  "Day 2 – Pull",
  "Deadlift 3x5 @ 275",
  "Barbell Row 3x8 @ 155",
].join("\n");

// 1 ── line model tags weeks and days
{
  const lines = parseProgramLines(PROG);
  eq(lines[3].week, 1, "week header tags following lines");
  eq(lines[3].day, "Monday", "weekday word tags the line");
  eq(lines[8].week, 2, "second week header advances the tag");
  const l2 = parseProgramLines(PROG2);
  ok(String(l2[1].day || "").toLowerCase().startsWith("day 1"), "Day-label header tags exercise lines");
  ok(String(l2[5].day || "").toLowerCase().startsWith("day 2"), "second Day label advances");
}

// 2 ── location: ambiguity refused, week/day disambiguates
{
  const amb = locateSwap(PROG, { find: "Recovery bench 3x5 at 140" });
  eq(amb.ok, false, "same text in 3 weeks with no scope = refused");
  eq(amb.reason, "ambiguous", "…as ambiguous");
  const w2 = locateSwap(PROG, { find: "Recovery bench 3x5 at 140", week: 2 });
  eq(w2.ok, true, "week narrows to one hit");
  eq(w2.week, 2, "…and reports the real week");
  const w9 = locateSwap(PROG, { find: "Recovery bench 3x5 at 140", week: 9 });
  eq(w9.reason, "no_match_in_scope", "a week with no hit refuses");
  const miss = locateSwap(PROG, { find: "Leg press 5x5" });
  eq(miss.reason, "not_found", "text not in the program refuses");
  const day = locateSwap(PROG, { find: "Front squat 4x3 at 270", day: "monday" });
  eq(day.ok, true, "day filter matches case-insensitively");
  const d2 = locateSwap(PROG2, { find: "Deadlift 3x5 @ 275", day: "Day 2" });
  eq(d2.ok, true, "Day-label programs locate by day too");
  // A drafter that guesses tags the program doesn't have must not veto a
  // perfectly located line (live failure 08-29: week:1 against a no-weeks
  // program refused everything).
  const guessedWeek = locateSwap(PROG2, { find: "Deadlift 3x5 @ 275", week: 1, day: "Day 2" });
  eq(guessedWeek.ok, true, "a guessed week is ignored when the program has no week headers");
  const wrongWeekStrict = locateSwap(PROG, { find: "Deadlift 4x4 at 290", week: 3 });
  eq(wrongWeekStrict.ok, false, "…but where weeks EXIST a wrong week still refuses");
  const guessedDay = locateSwap("Bench 3x5 @ 185\nRow 3x8 @ 155", { find: "Row 3x8 @ 155", day: "Day 2" });
  eq(guessedDay.ok, true, "a guessed day is ignored when no line carries a day tag");
}

// 3 ── apply: surgical, all-or-nothing, overlap-refusing
{
  const swaps = [
    { find: "Recovery bench 3x5 at 140, controlled, full range", replace: "Floor press 3x5, clean weight through the top", week: 1 },
    { find: "Recovery bench 3x5 at 140", replace: "Floor press 3x5", week: 2 },
    { find: "Recovery bench 3x5 at 140", replace: "Floor press 3x5", week: 3 },
  ];
  const r = applySwaps(PROG, swaps);
  eq(r.ok, true, "3-week swap applies");
  ok(!r.text.includes("Recovery bench"), "every target replaced");
  eq((r.text.match(/Floor press 3x5/g) || []).length, 3, "3 replacements, no more");
  ok(r.text.includes("Deadlift 4x4 at 270") && r.text.includes("Bench 5x2 at 200"), "everything else untouched");
  eq(r.text.split("\n").length, PROG.split("\n").length, "line count unchanged");

  const half = applySwaps(PROG, [swaps[0], { find: "Made-up lift 9x9", replace: "x", week: 2 }]);
  eq(half.ok, false, "a rec that half-fits refuses entirely");
  eq(half.reason, "outdated", "…as outdated");

  const dupNoScope = applySwaps(PROG, [{ find: "Recovery bench 3x5 at 140", replace: "x" }]);
  eq(dupNoScope.ok, false, "ambiguous swap refuses at apply time too");

  const overlap = applySwaps(PROG, [
    { find: "Bench 5x2 at 200 Dips 3x6 bodyweight", replace: "a", week: 1 },
    { find: "Dips 3x6 bodyweight", replace: "b", week: 1 },
  ]);
  eq(overlap.ok, false, "overlapping swaps refuse");
  eq(overlap.reason, "overlap", "…as overlap");
}

// 4 ── revert: restores, tolerates hand edits
{
  const swaps = [
    { find: "Recovery bench 3x5 at 140", replace: "Floor press 3x5", week: 2 },
    { find: "Recovery bench 3x5 at 140", replace: "Floor press 3x5", week: 3 },
  ];
  const applied = applySwaps(PROG, swaps);
  const back = revertSwaps(applied.text, swaps);
  eq(back.reverted, 2, "both swaps revert");
  eq(back.text, PROG, "revert restores the exact original");
  // hand-edit week 3's line after apply — revert leaves it alone, reports it
  const edited = applied.text.replace(/Floor press 3x5(?![\s\S]*Floor press 3x5)/, "Larsen press 4x5");
  const back2 = revertSwaps(edited, swaps);
  eq(back2.reverted, 1, "hand-edited line is skipped");
  eq(back2.missed.length, 1, "…and reported as missed");
}

// 5 ── durations: the hard set, no permanent
{
  eq(JSON.stringify(REC_DURATIONS), JSON.stringify(["1w", "2w", "3w", "block"]), "durations are exactly 1/2/3 weeks + block");
  eq(durationLabel("block"), "Rest of block", "block label");
  const base = new Date("2026-08-29T12:00:00Z");
  eq(recExpiry("2w", base), new Date("2026-09-12T12:00:00Z").toISOString(), "2w expiry = +14 days");
  eq(recExpiry("block", base), null, "block-scoped rec has no clock");
  ok(recExpired({ expiresAt: "2026-08-28T00:00:00Z" }, base.getTime()), "past expiry reads expired");
  ok(!recExpired({ expiresAt: null }, base.getTime()), "no clock never expires");
}

// 6 ── the pattern gate
{
  const now = new Date("2026-08-29T12:00:00Z");
  const note = buildWatchNote("pain", "shoulder on push press", now);
  eq(note.kind, "situational", "watch note is situational");
  ok(note.expires_at > now.toISOString(), "watch note expires on its own");
  ok(note.content.includes("(pain)") && note.content.includes("2026-08-29"), "note carries flag + date");

  const rows = [{ content: note.content, kind: "situational", expires_at: note.expires_at, status: "active" }];
  ok(!watchHit(rows, "pain", "shoulder on push press", now), "same-day repeat is ONE report, not a pattern");
  const tomorrow = new Date("2026-08-30T12:00:00Z");
  ok(watchHit(rows, "pain", "shoulder", tomorrow), "next-day repeat on the topic = pattern");
  ok(watchHit(rows, "pain", "push press shoulder ache", tomorrow), "similar phrasing still matches the topic");
  ok(!watchHit(rows, "pain", "knee", tomorrow), "different topic is not a pattern");
  ok(!watchHit(rows, "plateau", "shoulder", tomorrow), "different flag is not a pattern");
  const expired = [{ ...rows[0], expires_at: "2026-08-01T00:00:00Z" }];
  ok(!watchHit(expired, "pain", "shoulder", tomorrow), "an expired watch note is forgotten");

  ok(isSevereReport("sharp pain in my knee, had to stop"), "severe language skips the gate");
  ok(!isSevereReport("knee felt a little cranky today"), "mild language does not");

  // identity beats vibes: shared filler words are not a shared issue
  const kneeNote = [{ content: buildWatchNote("pain", "knee felt sore on squats", now).content, kind: "situational", expires_at: note.expires_at, status: "active" }];
  ok(!watchHit(kneeNote, "pain", "shoulder felt sore today", tomorrow), "'felt sore' overlap alone is NOT a pattern");
  ok(watchHit(kneeNote, "pain", "knee acting up again", tomorrow), "the named body part IS the pattern");
  eq(JSON.stringify(topicTokens("left pec pinches on bench and dips")), JSON.stringify(["pec", "bench", "dips"]), "topic tokens = body parts + lifts only");
}

// 7 ── payload validation
{
  const v = validateRecPayload({ title: "Left pec swap", why: "pain", origin: "pain", duration: "2w",
    swaps: [{ find: "Recovery bench 3x5 at 140", replace: "Floor press 3x5", week: 2 }] });
  eq(v.ok, true, "well-formed payload validates");
  eq(v.rec.duration, "2w", "duration kept");
  const bad = validateRecPayload({ title: "x", duration: "permanent", swaps: [{ find: "abc", replace: "" }] });
  eq(bad.ok, false, "tiny finds rejected (min length)");
  const clamped = validateRecPayload({ title: "t", duration: "permanent", swaps: [{ find: "Recovery bench 3x5", replace: "y" }] });
  eq(clamped.rec.duration, "block", "unknown duration (incl. 'permanent') clamps to block");

  // T64 Fix 3b: title/summary/why are three separate contracts now.
  const longTitle = "A".repeat(80);
  const titled = validateRecPayload({ title: longTitle, duration: "block", swaps: [{ find: "Recovery bench 3x5", replace: "y" }] });
  ok(titled.rec.title.length <= 40, "title is tightened to the tool schema's 40-char cap, not 60");

  const longSummary = "Will wants Monday's slot replaced with what he actually logged on Monday last week instead";
  const withSummary = validateRecPayload({
    title: "Front squat cap held", summary: longSummary,
    why: "internal reasoning", duration: "block", swaps: [{ find: "Recovery bench 3x5 at 140", replace: "Floor press 3x5" }],
  });
  eq(withSummary.rec.summary.split(" ").length, 12, "summary hard-caps at 12 words (not just described in the prompt)");
  ok(longSummary.startsWith(withSummary.rec.summary), "the cap trims from the end at a word boundary, never mid-word");
  ok(!withSummary.rec.summary.includes("instead"), "the 13th+ word never survives the cap");

  const noSummary = validateRecPayload({ title: "t", why: "internal", duration: "block", swaps: [{ find: "Recovery bench 3x5", replace: "y" }] });
  eq(noSummary.rec.summary, "", "summary defaults to empty, never undefined, when the model omits it");
  ok(!("why" in noSummary.rec) || typeof noSummary.rec.why === "string", "why still round-trips for the AI-context path even though it's never rendered");
}

// 8 ── athlete-facing fallback chain (T64 Fix 3): summary, else swaps, else title — NEVER why
{
  eq(recSummaryFallback({ summary: "Swapped Monday's squats with Tuesday's bench.", why: "Will wants..." }),
    "Swapped Monday's squats with Tuesday's bench.", "summary wins outright when present");
  eq(recSummaryFallback({ why: "Will asked to swap things", swaps: [{ find: "Front Squat 4x3 at 250", replace: "x" }, { find: "Pull-ups 3x8", replace: "y" }] }),
    "Changed Front Squat, Pull-ups.", "no summary: falls back to exercise names pulled from the swaps, never `why`");
  eq(recSummaryFallback({ why: "reasoning only", swaps: [{ find: "3x5 at 140", replace: "x" }] }),
    "1 spot changed in the program.", "a swap with no readable exercise name falls back to a bare count, still never `why`");
  eq(recSummaryFallback({ title: "Front squat cap held", why: "reasoning", swaps: [] }), "Front squat cap held", "no swaps at all: falls back to title");
  eq(recSummaryFallback(null), "", "null rec never throws");
  const manyNames = recSummaryFallback({ swaps: ["Overhead Press", "Deadlift", "Barbell Row", "Bicep Curl"].map((name) => ({ find: `${name} 3x5 at 100`, replace: "x" })) });
  ok(manyNames.startsWith("Changed Overhead Press, Deadlift, Barbell Row") && manyNames.endsWith("and more."), "more than 3 exercises: names the first 3, says 'and more'");
}

console.log(`\n${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
