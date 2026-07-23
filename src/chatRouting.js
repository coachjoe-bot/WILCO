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
export const ADVANCED_PARSE_RE = /superset|super set|drop\s?set|rest[- ]?pause|cluster|myo[- ]?reps?|amrap|to failure|warm[- ]?up|worked up|ramp(?:ed|ing)? up|giant set|triset/i;
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
