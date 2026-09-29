// ─── CHAT ROUTING: THE PURE DECISIONS BEHIND send() ──────────────────────────
// Every function here answers one question about a raw athlete message or a
// program's text, with no I/O and no React. They were inline regexes and helpers
// scattered through App.jsx's send() path — the hottest, highest-consequence code
// in the product — where a one-character change to a pattern silently reroutes a
// workout log into a program overwrite, or sends a cheap Haiku parse where the
// message actually needed Sonnet.
//
// Extracted so those patterns get a regression suite (scripts/test-chat-routing.mjs)
// rather than living as untested literals. Behavior is byte-identical to the
// inline versions; this is a move, not a rewrite.

// ── Model routing for the workout parser ─────────────────────────────────────
// Advanced set structures (supersets, drop sets, myo-reps, ramping warm-ups) are
// where Haiku reliably drops exercises into general_notes with an empty
// exercises[] — the workout then never appears in the log at all. Those go
// straight to Sonnet; everything else stays Haiku-first (~3x cheaper).
// Attempt/miss language is in the list because a misread there doesn't lose a
// workout — it MINTS a false max (a failed 285 logged as a set becomes the
// athlete's actual 1RM via the true-single promotion). Worth a Sonnet parse
// every time.
export const ADVANCED_PARSE_RE = /superset|super set|drop\s?set|rest[- ]?pause|cluster|myo[- ]?reps?|amrap|to failure|warm[- ]?up|worked up|ramp(?:ed|ing)? up|giant set|triset|attempt|missed|\bfail(?:ed)?\b|didn'?t (?:get|make|hit)|no lift/i;
export const needsAdvancedParser = (message) => ADVANCED_PARSE_RE.test(String(message || ""));

// Does this message clearly describe lifting? Only used to decide whether an
// EMPTY Haiku parse is worth re-running on Sonnet — so it must stay cheap and
// permissive. A false positive costs one extra parse; a false negative loses the
// athlete's workout.
export const LOOKS_LIKE_LIFTING_RE = /\d+\s*x\s*\d+|@\s*\d|\d+\s*(?:lbs?|kgs?)\b/i;
export const looksLikeLifting = (message) => LOOKS_LIKE_LIFTING_RE.test(String(message || ""));

// Did the parse come back with nothing structured? (Any one of exercises, a run,
// a practice, or a PR attempt counts as "something".)
export const parseGotNothing = (parsed) =>
  !parsed || (
    (!Array.isArray(parsed.exercises) || parsed.exercises.length === 0) &&
    !parsed.run_data && !parsed.practice_data &&
    (!Array.isArray(parsed.pr_attempts) || parsed.pr_attempts.length === 0)
  );

// ── Failed attempts must never become logged sets ────────────────────────────
// The parser is told a missed attempt goes ONLY in pr_attempts (achieved:false),
// but a rule the model must remember is not a guarantee — and one leaked
// "Bench 1x1 @285" from a miss gets promoted to the athlete's ACTUAL 1RM by the
// true-single pass and lands on every progress surface. This strips the leak
// deterministically before anything is saved or promoted: for each failed
// attempt, remove matching sets (same lift, same weight, same rep count) from
// exercises[]. The achieved:false entry itself stays in parsed_data — it's the
// record that the attempt happened, and every max consumer already filters on
// `achieved`. A weight the athlete ALSO reports as achieved at the same lift is
// left alone (they hit it on another attempt in the same session).
export const stripFailedAttempts = (parsed, normalizeName = (s) => String(s || "").toLowerCase().trim()) => {
  const failed = (parsed?.pr_attempts || []).filter(p => p && p.achieved === false && p.exercise && p.weight);
  if (!failed.length || !Array.isArray(parsed?.exercises) || !parsed.exercises.length) return parsed;
  const achieved = (parsed.pr_attempts || []).filter(p => p && p.achieved && p.exercise && p.weight);
  const isAchievedToo = (name, w) =>
    achieved.some(a => normalizeName(a.exercise) === name && Math.abs(a.weight - w) < 0.51);
  const exercises = parsed.exercises.map(ex => {
    if (!ex || !ex.name) return ex;
    const exName = normalizeName(ex.name);
    const hits = failed.filter(f => normalizeName(f.exercise) === exName && !isAchievedToo(exName, f.weight));
    if (!hits.length) return ex;
    const matchesMiss = (w, reps) =>
      w != null && hits.some(f => Math.abs(f.weight - w) < 0.51 && (reps == null || reps === (f.reps || 1)));
    if (Array.isArray(ex.set_details) && ex.set_details.length) {
      const kept = ex.set_details.filter(s => s.warmup || !matchesMiss(s.weight, s.reps));
      if (kept.length === ex.set_details.length) return ex;
      if (!kept.length) return null; // every set was the miss — the entry shouldn't exist
      // Re-derive the flat summary from the surviving sets so nothing downstream
      // reads the stripped weight out of the top-set fields.
      const top = kept.reduce((b, s) => (!b || (s.weight || 0) > (b.weight || 0) ? s : b), null);
      return { ...ex, set_details: kept, sets: kept.filter(s => !s.warmup).length || kept.length, weight: top?.weight ?? ex.weight, reps: top?.reps ?? ex.reps };
    }
    if (!matchesMiss(ex.weight, ex.reps)) return ex;
    // Flat entry at the missed weight: a lone single vanishes; "5 singles,
    // missed the last" keeps its 4 completed sets.
    return (ex.sets || 1) > 1 ? { ...ex, sets: ex.sets - 1 } : null;
  }).filter(Boolean);
  return { ...parsed, exercises };
};

// ── "Remember this" detection ────────────────────────────────────────────────
// A saved context note is durable and gets injected into every future prompt, so
// it may only be written when the athlete ASKED for it in as many words. The
// parser's own is_explicit flag is necessary but not sufficient — this pattern is
// the second, deterministic gate.
export const EXPLICIT_MEMORY_RE = /\b(remember|note that|make a note|keep in mind|don'?t forget|from now on|for future reference|going forward|just so you know|for the record|update my (info|profile|weight))\b/i;
export const asksToRemember = (message) => EXPLICIT_MEMORY_RE.test(String(message || ""));

// ── Is this row a workout log? ───────────────────────────────────────────────
// Used to keep pure-chat rows out of windows that are supposed to contain logged
// work (the log-correction candidate list, the Quick Log staleness view). A
// question to the coach is never a log, even when it mentions numbers.
export const looksLikeWorkoutLog = (raw) => {
  if (typeof raw !== "string") return false;
  const s = raw.trim();
  if (!s || s.startsWith("[Form review:")) return false;
  const first = s.split("\n")[0].trim();
  // A question / request to the coach is not a log.
  if (/\?/.test(first) || /^\s*(what|when|which|can|could|should|is|are|do|does|how|why|show|tell|give)\b/i.test(first)) return false;
  // A log carries set×rep or @weight or a bare lbs/kg load.
  return /\b\d+\s*[x×]\s*\d+/i.test(s) || /@\s*\d/.test(s) || /\b\d+\s*(lbs|kg)\b/i.test(s);
};

// ── PR propagation guards ────────────────────────────────────────────────────
// Does the program pin its numbers to a basis the athlete chose ON PURPOSE (a
// training max, stated working weights, a named reference the percentages hang
// off) rather than tracking their true 1RM? If so, a new PR must NOT rescale
// them — that would silently overwrite a deliberate choice. Guard on the
// deterministic fallback path only; the AI path reasons about this itself.
export const hasExplicitWorkingBasis = (programText) =>
  /training max|\bTM\b|working (?:max|weight|set|number)|work(?:ing)? weight|based (?:on|off)|%.{0,20}\bof\b.{0,20}(?:working|training)/i.test(programText || "");

// Deterministic 1RM propagation: on the lines that name the lift, rescale each
// absolute weight by the same percentage of the new max, rounded to the nearest 5.
//
// The two bounds are the whole safety story. Below 45 lbs is a bar/plate note, not
// a prescribed load; above old1RM × 1.5 is a goal number or a typo, not a working
// weight. Rescaling either would produce a program the athlete never chose, so
// both are left exactly as written.
export const propagate1RM = (programText, exerciseName, old1RM, new1RM) => {
  if (!programText || !old1RM || !new1RM || old1RM === new1RM || old1RM <= 0) return { text: programText, changed: false };
  const safeEx = String(exerciseName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = programText.split("\n");
  let changed = false;
  const updated = lines.map((line) => {
    if (!(new RegExp(safeEx, "i")).test(line)) return line;
    return line.replace(/(\d+)\s*(lbs?)/gi, (match, num) => {
      const w = +num;
      if (w < 45 || w > old1RM * 1.5) return match; // skip bar weight / outliers
      const pct = w / old1RM;
      const newW = Math.round((new1RM * pct) / 5) * 5;
      if (newW === w) return match;
      changed = true;
      return `${newW}lbs`;
    });
  });
  return { text: updated.join("\n"), changed };
};

// ── Truncated-echo guard ─────────────────────────────────────────────────────
// Both AI program-rewrite paths (PR propagation and the check-in injury rewrite)
// ask the model to hand the FULL program back. When the response is cut off by the
// token cap, what returns is a PREFIX of the original — and writing that prefix
// over program_text destroys everything after the cut. So a rewrite is only
// accepted when it is long enough to plausibly be the whole thing.
//
// Moved verbatim from App.jsx; the two thresholds are unchanged. 60 chars kills a
// one-line apology or refusal; 0.9 of the original kills a truncation. Deliberately
// strict — a rejected good rewrite costs the athlete one retry, an accepted
// truncation costs them their program.
export const isFullProgramEcho = (prog, programText) =>
  !!prog && prog.length >= 60 && prog.length >= String(programText || "").length * 0.9;

// ── explicit program-edit ask ─────────────────────────────────────────────────
// "add a day 4 to my program: Deadlift 4x3 @ RPE 7" parsed as a PERFORMED
// workout on prod (T57 s5 live find): the model missed program_append, the
// message's exercises entered the athlete's history as a phantom session, and
// every real log that day became a same-session "continuation" — no WORKOUT
// stamp. The ask is deterministic, so the model doesn't get a vote: a
// present-tense add/append/put/tack/stick aimed at "my program/plan/split" is
// a program EDIT, never a log. ("added ... yesterday" stays a log: \b keeps
// past-tense forms out.)
export const PROGRAM_EDIT_ASK_RE = /\b(?:add|append|put|tack|stick)\b[^.!?\n]{0,60}\b(?:to|onto|into|in|on)\s+my\s+(?:program|plan|split|training plan)\b/i;
export const asksProgramEdit = (message) => PROGRAM_EDIT_ASK_RE.test(String(message || ""));

// ── explicit temp-program ask (T64 S6, verifier BUG-3) ───────────────────────
// Live QA, 09-28: over three turns Joe laid out a full six-day dumbbell plan,
// the athlete said "yes set me up with that temporary program for the week",
// the parser raised no is_temp_program_update flag, nothing was written, and
// Joe answered "Already built that for you above." The ask is deterministic,
// so the model doesn't get a vote: an imperative set-up / make / save / lock /
// switch aimed at "that/this/the plan", a temp/travel program, or "for the
// week/trip" is an explicit request to save the plan Joe laid out
// (src/changeScope.js tempTurnBefore finds which one). A question ("can you
// set me up...?") counts too: it is still the athlete asking for it. Past
// tense ("you set me up yesterday") stays out: the verbs are present-tense.
const TEMP_TARGET = "(?:(?:that|this|the|it|a|my|your)\\s+)?(?:temp(?:orary)?|travel|trip|road|vacation|away|garage|hotel|dumbbell|db)\\s+(?:program|plan|week|schedule|routine|version)";
const THAT_PLAN = "(?:that|those)\\s+(?:plan|program|week|schedule|routine|version|days)";
export const TEMP_PROGRAM_ASK_RE = new RegExp(
  "\\b(?:set\\s+(?:me|it|that|this)\\s+up|set\\s+up|make|save|lock|load|put\\s+me\\s+on|switch\\s+me\\s+(?:to|over\\s+to)|use|go\\s+with|run\\s+with|apply|start\\s+me\\s+on)\\b" +
  "[^.!?\\n]{0,40}?(?:" + TEMP_TARGET + "|" + THAT_PLAN + "|\\b(?:that|it|this)\\s+in\\b[^.!?\\n]{0,20}\\bfor\\s+(?:the|this)\\s+(?:week|trip)\\b|\\b(?:that|this|it)\\s+(?:my|as\\s+my)\\s+(?:temp(?:orary)?\\s+)?(?:program|plan))",
  "i");
export const asksTempProgram = (message) => TEMP_PROGRAM_ASK_RE.test(String(message || ""));

// ── Tool-name leakage filter (T62) ───────────────────────────────────────────
// The model sometimes narrates its own tool calls INTO its prose — Will's 08-31
// screenshot had "prefill_log_sheet, pin_session_card" as the first line of
// Joe's bubble. The SSE relay and the stream client both keep tool frames out
// of the text (verified), so the identifiers arrive as model-written TEXT; the
// prompt already forbids it, and a prompt rule can be ignored. This filter
// cannot: every assistant bubble renders through it (which also cleans history
// rows persisted before the fix), and send() runs settled replies through it
// before they reach bot_reply.
//
// The list is every tool name the model can see (api/_tools.js TOOLSETS plus
// the HARD_CONFIRM_FLOOR v2 names). The client can't import the server module,
// so scripts/test-chat-routing.mjs asserts this copy stays in sync — a new
// server tool that isn't added here fails the suite, not the athlete.
export const KNOWN_TOOL_NAMES = [
  "set_position", "remember_fact", "forget_fact",
  "pin_session_card", "clear_session_card", "prefill_log_sheet",
  "propose_program_rec", "propose_preference", "show_start_buttons",
  "replace_program", "delete_log_entry", "send_coach_request",
];
const TOOL_NAME_SRC = `\\b(?:${KNOWN_TOOL_NAMES.join("|")})\\b(?:\\(\\))?`;
// A line that was ONLY tool noise (names, commas, arrows, bullets) vanishes
// entirely; a name inside a real sentence is excised and the seams cleaned.
const TOOL_SEPARATORS_RE = /^[\s,;:·•|&+/\\\-–—>()[\]{}]*$/;
export const stripToolNameNoise = (text) => {
  const t = String(text ?? "");
  if (!KNOWN_TOOL_NAMES.some((n) => t.includes(n))) return t;
  const out = [];
  for (const line of t.split("\n")) {
    const nameRe = new RegExp(TOOL_NAME_SRC, "g");
    if (!nameRe.test(line)) { out.push(line); continue; }
    let s = line.replace(new RegExp(TOOL_NAME_SRC, "g"), "");
    if (TOOL_SEPARATORS_RE.test(s)) continue;
    s = s.replace(/\(\s*\)/g, "")
      .replace(/,(\s*,)+/g, ",")
      .replace(/^[\s,;:·•|&\-–—>]+/, "")
      .replace(/[\s,;:·•|&\-–—>]+$/, "")
      .replace(/\s{2,}/g, " ");
    if (s) out.push(s);
  }
  return out.join("\n").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
};
