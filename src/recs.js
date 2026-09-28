// ─── PROGRAM RECS (Will's 08-28 design, mockup docs/mockups/program-recs-mockup.html) ──
// Pure logic for staged program changes: locate the EXACT program text a change
// replaces (week/day aware, so "Recovery bench 3x5 at 140" in week 2 vs week 3
// is never ambiguous), apply and revert deterministically, and run the pattern
// gate ("first mention = watched note, a Rec needs a repeat"). No I/O, no
// React — App.jsx owns the AI calls and gateway writes; everything here is
// unit-tested in scripts/test-recs.mjs.
//
// The apply contract (Will): what the athlete approved lands byte-for-byte.
// The AI proposes swaps; this module refuses any swap it cannot locate
// UNIQUELY in the live program, and apply is a plain substring replacement —
// no model touches the program at apply time.

// ── line model ───────────────────────────────────────────────────────────────
// Tag every line with the week/day region it sits in. Handles both program
// shapes in the wild: whole-day-on-one-line ("Monday Front squat 4x3 at 250 …")
// and day-header-plus-exercise-lines ("Day 3 – Pull" / one lift per line).
const WEEK_RE = /^\s*week\s*(\d+)\b/i;
const DAY_WORD_RE = /^\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const DAY_LABEL_RE = /^\s*(day\s*\d+[^a-z0-9]?[^\n]*?)(?:\s{2,}|:|$)/i;

export function parseProgramLines(text) {
  const out = [];
  let week = null, day = null;
  const lines = String(text || "").split("\n");
  let offset = 0;
  for (const raw of lines) {
    const w = raw.match(WEEK_RE);
    if (w) { week = parseInt(w[1], 10); day = null; }
    const dw = raw.match(DAY_WORD_RE);
    const dl = raw.match(DAY_LABEL_RE);
    if (dw) day = dw[1][0].toUpperCase() + dw[1].slice(1).toLowerCase();
    else if (dl) day = dl[1].trim().replace(/\s+/g, " ");
    out.push({ text: raw, start: offset, end: offset + raw.length, week, day });
    offset += raw.length + 1; // the split-off \n
  }
  return out;
}

// ── locating swaps ───────────────────────────────────────────────────────────
// A swap = { find, replace, week?, day? }. `find` must be an exact substring of
// the program; week/day narrow it when the same text appears in more than one
// place. Resolution must land on EXACTLY ONE occurrence or the swap is refused
// (ambiguous beats wrong — the athlete re-scopes by talking to Joe).
const dayNorm = (d) => String(d || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function locateSwap(text, swap) {
  const t = String(text || "");
  const find = String(swap?.find || "");
  if (!find.trim()) return { ok: false, reason: "empty_find" };
  const lines = parseProgramLines(t);
  const hits = [];
  let idx = t.indexOf(find);
  while (idx !== -1) {
    const line = lines.find((l) => idx >= l.start && idx < l.end) || null;
    hits.push({ index: idx, week: line ? line.week : null, day: line ? line.day : null });
    idx = t.indexOf(find, idx + 1);
  }
  if (!hits.length) return { ok: false, reason: "not_found" };
  let cands = hits;
  // Scope filters are STRICT only when the program actually carries the tag:
  // a drafter that guesses "week: 1" against a program with no week headers
  // must not veto a perfectly located line (live failure, 08-29). Where the
  // program HAS weeks, a wrong week still refuses — ambiguity beats wrong.
  if (swap.week != null && hits.some((h) => h.week != null)) {
    cands = cands.filter((h) => h.week === swap.week);
  }
  if (swap.day && cands.some((h) => h.day)) {
    cands = cands.filter((h) => dayNorm(h.day).startsWith(dayNorm(swap.day)) || dayNorm(swap.day).startsWith(dayNorm(h.day)));
  }
  if (!cands.length) return { ok: false, reason: "no_match_in_scope", hits };
  if (cands.length > 1) return { ok: false, reason: "ambiguous", hits: cands };
  return { ok: true, index: cands[0].index, week: cands[0].week, day: cands[0].day };
}

// Validate a whole rec's swaps against the LIVE program. Returns the located
// swaps (with their real week/day tags for display) and the rejects.
export function locateSwaps(text, swaps) {
  const located = [], rejected = [];
  for (const s of Array.isArray(swaps) ? swaps : []) {
    const r = locateSwap(text, s);
    if (r.ok) located.push({ ...s, week: r.week ?? s.week ?? null, day: r.day ?? s.day ?? null, index: r.index });
    else rejected.push({ ...s, reason: r.reason });
  }
  return { located, rejected };
}

// ── apply / revert ───────────────────────────────────────────────────────────
// Deterministic: re-locate every swap at apply time (the program may have moved
// since the rec was drafted), then splice. All-or-nothing — a rec that half
// fits is OUTDATED, never half-applied.
export function applySwaps(text, swaps) {
  const t = String(text || "");
  const { located, rejected } = locateSwaps(t, swaps);
  if (rejected.length || !located.length) return { ok: false, reason: rejected.length ? "outdated" : "empty", rejected };
  // two swaps must never overlap in the text — that's a drafting error, refuse
  const inOrder = [...located].sort((a, b) => a.index - b.index);
  for (let i = 1; i < inOrder.length; i++) {
    if (inOrder[i].index < inOrder[i - 1].index + inOrder[i - 1].find.length) {
      return { ok: false, reason: "overlap", rejected: [inOrder[i]] };
    }
  }
  // splice back-to-front so earlier indices stay valid
  let out = t;
  for (const s of [...located].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, s.index) + String(s.replace || "") + out.slice(s.index + s.find.length);
  }
  return { ok: true, text: out };
}

// Put it back: replace each swap's `replace` text with its original `find`.
// Tolerant on purpose — lines the athlete has since hand-edited are left
// alone and reported, the rest revert.
export function revertSwaps(text, swaps) {
  let out = String(text || "");
  let reverted = 0; const missed = [];
  for (const s of Array.isArray(swaps) ? swaps : []) {
    const rep = String(s.replace || "");
    if (!rep.trim()) { missed.push(s); continue; }
    const r = locateSwap(out, { find: rep, week: s.week, day: s.day });
    if (!r.ok) { missed.push(s); continue; }
    out = out.slice(0, r.index) + String(s.find || "") + out.slice(r.index + rep.length);
    reverted++;
  }
  return { text: out, reverted, missed };
}

// ── durations ────────────────────────────────────────────────────────────────
// Will's ruling: hard numbers only — 1/2/3 weeks or the rest of the block.
// No permanent: a Rec never outlives its block. "block" recs carry no expiry
// and retire with the block.
export const REC_DURATIONS = ["1w", "2w", "3w", "block"];
export const durationLabel = (d) =>
  d === "1w" ? "1 week" : d === "2w" ? "2 weeks" : d === "3w" ? "3 weeks" : "Rest of block";

export function recExpiry(duration, appliedAt = new Date()) {
  const n = duration === "1w" ? 1 : duration === "2w" ? 2 : duration === "3w" ? 3 : null;
  if (n == null) return null; // block-scoped: retires with the block, no clock
  const t = new Date(appliedAt);
  t.setDate(t.getDate() + n * 7);
  return t.toISOString();
}

export const recExpired = (rec, now = Date.now()) => {
  const e = rec && rec.expiresAt ? Date.parse(rec.expiresAt) : NaN;
  return Number.isFinite(e) && e <= now;
};

// ── the pattern gate (Will's discipline rule) ────────────────────────────────
// First mention of an auto-flag = a WATCHED NOTE (a situational memory fact
// that expires on its own). A Rec drafts only when (1) an ACTIVE watch note on
// the same topic already exists from a DIFFERENT local day — the repeat, (2)
// the report is clearly serious, or (3) the athlete explicitly asked (that
// path never comes through the gate at all). One bar for every auto-flag:
// pain, plateau, equipment (Will agreed 08-29).
export const WATCH_TTL_DAYS = 14;
const WATCH_PREFIX = "Watching:";

export const watchTopic = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim().slice(0, 40);

// The Memory tab renders these under a WATCHING chip (Will 08-29: he wants to
// SEE what the AI tracks) — the prefix is the identity, so one test-covered
// predicate instead of a second string literal drifting in App.jsx.
export const isWatchNote = (content) => String(content || "").startsWith(WATCH_PREFIX);

// Topic identity = body parts + lift words, never filler. "knee felt sore" and
// "shoulder felt sore" must NOT read as the same issue just because they share
// "felt sore" — the pattern rule is per-issue, not per-vibe.
const BODY_WORDS = new Set(("shoulder shoulders pec pecs chest knee knees back lowback hip hips elbow elbows wrist wrists ankle ankles hamstring hamstrings quad quads calf calves neck groin bicep biceps tricep triceps forearm forearms glute glutes achilles shin shins traps lat lats spine adductor").split(" "));
const LIFT_WORDS = new Set(("bench press squat squats deadlift deadlifts row rows pull pullup pullups chinup dip dips clean cleans snatch jerk press ohp curl curls lunge lunges rdl extension extensions raise raises fly flyes shrug shrugs thruster pulldown pushup pushups plank sprint sprints").split(" "));
export function topicTokens(s) {
  const words = watchTopic(String(s || "").slice(0, 400)).split(" ");
  const hits = words.filter((w) => BODY_WORDS.has(w) || LIFT_WORDS.has(w));
  return [...new Set(hits)];
}

export function buildWatchNote(flag, topic, now = new Date()) {
  const expires = new Date(now); expires.setDate(expires.getDate() + WATCH_TTL_DAYS);
  return {
    content: `${WATCH_PREFIX} ${topic} (${flag}) reported ${now.toISOString().slice(0, 10)} - a repeat within 2 weeks earns a program rec`.slice(0, 240),
    kind: "situational",
    expires_at: expires.toISOString(),
  };
}

// Is there an active watch on this topic from a PREVIOUS day? (Mentioning the
// same pain twice in one conversation is one report, not a pattern.)
export function watchHit(memoryRows, flag, topic, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  // Identity tokens (body parts + lifts) when the message names any; the
  // normalized words as a fallback so an unlisted issue can still pattern-match.
  const idTokens = topicTokens(topic);
  const fallback = watchTopic(topic).split(" ").filter((w) => w.length > 3);
  const tWords = idTokens.length ? idTokens : fallback;
  if (!tWords.length) return false;
  return (memoryRows || []).some((r) => {
    if (!r || r.status === "deleted") return false;
    const c = String(r.content || "");
    if (!c.startsWith(WATCH_PREFIX)) return false;
    if (r.expires_at && Number.isFinite(Date.parse(r.expires_at)) && Date.parse(r.expires_at) <= now.getTime()) return false;
    const stamped = c.match(/reported (\d{4}-\d{2}-\d{2})/);
    if (stamped && stamped[1] === today) return false;
    if (!c.includes(`(${flag})`)) return false;
    // Compare identities, not vibes: when the note carries body/lift tokens,
    // require one of THOSE to match; generic word overlap only when neither
    // side named anything recognizable.
    const cTokens = topicTokens(c);
    if (idTokens.length && cTokens.length) return idTokens.some((w) => cTokens.includes(w));
    const cNorm = watchTopic(c);
    return tWords.some((w) => cNorm.includes(w));
  });
}

// Clearly serious on first report — sharp/stopping language skips the gate.
export const SEVERE_RE = /\bsharp\b|\bsevere\b|\bcan'?t (finish|continue|move|lift|walk)\b|\bhad to (stop|quit|bail)\b|\bgave out\b|\bpop(ped)?\b|\btore|torn\b|\bshooting pain\b/i;
export const isSevereReport = (msg) => SEVERE_RE.test(String(msg || ""));

// ── athlete-facing fallback text (T64 Fix 3 + 3b) ────────────────────────────
// recSummaryFallback below is what a Drafts-pane card or the rec sheet renders
// when a row has no `summary` yet (every real rec on prod today, until Fix 3b
// adds that field and the backfill runs) — built from the swap's own exercise
// names, never the internal `why` (Fix 3b: `why` was doing two incompatible
// jobs, the model's own rationale AND the only text rendered on the card, so
// the athlete read "Will wants Monday's slot replaced with..." about their own
// program). trimChars/capWords are shared with `summary`'s own cap in
// validateRecPayload.

// Trim to a character cap at a word boundary — never chop mid-word.
function trimChars(s, maxChars) {
  const t = String(s || "").trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars).replace(/\s+\S*$/, "").trim();
}
// Cap at a WORD count (Will's rule for `summary`: 12 words or fewer) — the
// model's own count is never authoritative (coach-brain doctrine: compute the
// fact in code), so this is enforced here, not just described in the prompt.
function capWords(s, maxWords) {
  const t = String(s || "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  const words = t.split(" ");
  return words.length <= maxWords ? t : words.slice(0, maxWords).join(" ");
}

// A short, factual line for a rec row that predates `summary` (every real rec
// on prod today) or whose generation skipped it: named exercises from what the
// swaps actually replace, never the internal `why`. Pure and stable so the
// same row always renders the same fallback line.
const FIND_EXERCISE_RE = /^([A-Za-z][A-Za-z0-9'/\- ]*?)(?:\s+\d|\s*[:@]|$)/;
export function recSummaryFallback(rec) {
  if (!rec) return "";
  const summary = String(rec.summary || "").trim();
  if (summary) return summary;
  const swaps = Array.isArray(rec.swaps) ? rec.swaps : [];
  if (swaps.length) {
    const names = swaps
      .map((s) => { const m = FIND_EXERCISE_RE.exec(String(s?.find || "").trim()); return m ? m[1].trim() : ""; })
      .filter(Boolean);
    const uniq = [...new Set(names)];
    if (uniq.length) {
      const list = uniq.slice(0, 3).join(", ");
      return `Changed ${list}${uniq.length > 3 ? " and more" : ""}.`;
    }
    return `${swaps.length} spot${swaps.length === 1 ? "" : "s"} changed in the program.`;
  }
  return String(rec.title || "").trim();
}

// ── rec payload shape (stored in program_drafts.blueprint.rec) ───────────────
// { v:1, title, why, origin, duration, swaps:[{find,replace,week,day}],
//   parked, appliedAt?, expiresAt? }
export function validateRecPayload(rec) {
  if (!rec || typeof rec !== "object") return { ok: false, reason: "empty" };
  const title = String(rec.title || "").trim().slice(0, 60);
  const why = String(rec.why || "").trim().slice(0, 500);
  const duration = REC_DURATIONS.includes(rec.duration) ? rec.duration : "block";
  const swaps = (Array.isArray(rec.swaps) ? rec.swaps : [])
    .map((s) => ({
      find: String(s?.find || "").trim(),
      replace: String(s?.replace || "").trim(),
      week: Number.isFinite(s?.week) ? s.week : (s?.week != null && /^\d+$/.test(String(s.week)) ? parseInt(s.week, 10) : null),
      day: s?.day ? String(s.day).trim().slice(0, 30) : null,
    }))
    .filter((s) => s.find && s.find.length >= 4);
  if (!title || !swaps.length) return { ok: false, reason: !title ? "no_title" : "no_swaps" };
  return { ok: true, rec: { v: 1, title, why, origin: String(rec.origin || "ask").slice(0, 20), duration, swaps, parked: !!rec.parked } };
}
