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
const PROTECT_RE = /\b(deload|de-load|recover(y|ing)?|rehab\w*|prehab\w*|protect\w*|avoid\w*|easy on|go easy|back off|\w+[- ]friendly|no (heavy |deep |more |added )?(squat\w*|pull\w*|press\w*|bench\w*|running|jump\w*|plyo\w*|overhead|dips?|lunges?|deadlift\w*|load\w*|single[- ]leg)|until (?:the |your |my |it |that )?[\w ]{0,20}?(settles?|clears?|calms?|resolves?|heals?|feels (?:right|good|fine))|if (the|your|my) \w+ (talks|barks|hurts|flares)|still (lingering|talking|barking|sore|tender)|tender|irritated|flare[- ]?ups?|train(ing)? around|work(ing)? around|spare|careful with|stay off|keep \w+ (quiet|calm)|quiet (weeks?|days?)|give the \w+ (a |some |two |three |a few )?(quiet|rest|break|time)|active issue|restore \w+ (mobility|stability))\b/i;

// Lift jargon that carries a body word but names no sore area.
const JARGON = /\b(rear[- ]foot|front[- ]foot|lead foot|single[- ]leg|split stance|toes? to bar|hip hinge|knee[- ]to[- ]chest)\b/gi;

// A header line ("WEEK 1 ... DELOAD", "Day 3 - Active Recovery") can carry the
// protective word for the line right under it ("Knees, upper back and
// shoulders."). Only headers pass their language down; cues inside exercise
// lines never chain.
const isHeader = (l) => l.length <= 80 && (/^(week|wk|day|mon|tue|wed|thu|fri|sat|sun|block|phase|focus|goal|intent)\b/i.test(l) || (l === l.toUpperCase() && /[A-Z]/.test(l)));

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
  if (!goal) { const g = lines.find((l) => /^(intent|goal|purpose)(?: of the (?:block|program))?\s*[:—-]?\s+\S/i.test(l)); if (g) goal = g.replace(/^(intent|goal|purpose)(?: of the (?:block|program))?\s*[:—-]?\s*/i, ""); }

  const protects = new Set();
  const notes = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const areas = areasInText(l.replace(JARGON, " "));
    if (!areas.length) continue;
    const prev = lines[i - 1] || "";
    if (PROTECT_RE.test(l) || (isHeader(prev) && PROTECT_RE.test(prev))) {
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
