// ─── PROGRAM PURPOSE — what a program is FOR (T64 S2) ────────────────────────
// Will, 09-28: "Programs built to fix a pain point must not trigger
// recommendations to change the program for that same pain." The program's own
// words say what it protects: its INTENT block, week and day notes ("No
// squatting, no pulls until Friday", "pec's still lingering", "Hip, low back,
// knee recovery", "If the pec talks, the set is over"). This reads them
// deterministically. No model call; cached by a hash of the program text.
//
// programPurpose(text) -> { goal, protects: [areaKeys], notes: [lines] }
// The pain ledger sets `addressedByProgram` from `protects`; the rec drafter is
// told the same list so a rec never proposes changing what is already protected.

import { areasInText } from "./painLedger.js";

// Protective language: a deload/recovery/rehab note, an explicit "no X",
// "until it settles", "if it talks", "still lingering", "protect", "easy on".
const PROTECT_RE = /\b(deload|de-load|recover(y|ing)?|rehab\w*|prehab\w*|protect\w*|avoid\w*|easy on|go easy|back off|pain[- ]free|no (heavy |deep |more )?(squat\w*|pull\w*|press\w*|bench\w*|running|jump\w*|overhead|dips?|lunges?|deadlift\w*)|until (it|the \w+|that|they) (settles?|clears?|calms?)|if (the|your|my) \w+ (talks|barks|hurts|flares)|still (lingering|talking|barking|sore|tender)|lingering|tender|sensitive|irritated|flare[- ]?ups?|train(ing)? around|work(ing)? around|spare|careful with|stay off|keep \w+ (quiet|calm))\b/i;

// Lines that are only a list of exercises are not protective notes even when a
// lift name carries a body word ("terminal knee extensions" on a recovery day is
// covered by the day header, which the window catches).
const EXERCISE_LINE = /^\s*[*•-]\s/;

const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + ":" + s.length; };
const CACHE = new Map();
const CACHE_MAX = 50;

export function programPurpose(programText) {
  const text = String(programText || "");
  if (!text.trim()) return { goal: null, protects: [], notes: [] };
  const key = hash(text);
  if (CACHE.has(key)) return CACHE.get(key);

  const lines = text.split(/\r?\n/).map((l) => l.trim());
  // goal: the line(s) under INTENT / GOAL, else a "Goal:" line
  let goal = null;
  const iIdx = lines.findIndex((l) => /^(intent|goal|goals|purpose)\b[:\s]*$/i.test(l));
  if (iIdx >= 0) goal = lines.slice(iIdx + 1).find((l) => l && !/^[A-Z ]{4,}$/.test(l)) || null;
  if (!goal) { const g = lines.find((l) => /^(intent|goal|purpose)\s*[:—-]\s*\S/i.test(l)); if (g) goal = g.replace(/^(intent|goal|purpose)\s*[:—-]\s*/i, ""); }

  const protects = new Set();
  const notes = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l || EXERCISE_LINE.test(l)) continue;
    const areas = areasInText(l);
    if (!areas.length) continue;
    // protective language in the line itself or the header right above it
    // ("WEEK 1 ... DELOAD" then "Knees, upper back and shoulders.")
    const prev = lines[i - 1] || "";
    if (PROTECT_RE.test(l) || (PROTECT_RE.test(prev) && !EXERCISE_LINE.test(prev))) {
      areas.forEach((a) => protects.add(a));
      notes.push(l.slice(0, 160));
    }
  }
  const out = Object.freeze({ goal: goal ? goal.slice(0, 200) : null, protects: [...protects], notes: notes.slice(0, 6) });
  if (CACHE.size >= CACHE_MAX) CACHE.clear();
  CACHE.set(key, out);
  return out;
}

// One line for a prompt (rec drafter, check-in, chat ledger block).
export function purposeLine(purpose) {
  if (!purpose) return "";
  const bits = [];
  if (purpose.goal) bits.push(`Goal: ${purpose.goal}`);
  if (purpose.protects && purpose.protects.length) bits.push(`Already protects: ${purpose.protects.map((a) => a.replace("_", " ")).join(", ")}`);
  return bits.join(". ");
}
