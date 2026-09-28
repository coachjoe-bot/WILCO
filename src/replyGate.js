// ─── ONE GATE FOR MODEL OUTPUT (T64 S4, AI contract rule 8) ──────────────────
// Every model-written string passes replyGate() before it renders or is stored.
// Pure: no React, no network. In order:
//   1. strip tool names the model narrated into prose (stripToolNameNoise, T62)
//   2. remove banned words, leaving a clean sentence (Will 09-28: WILCO never
//      curses, not even "damn", even when the athlete does)
//   3. normalize em dashes to commas (the voice law bans them; the model slips)
//   4. on chat surfaces (ctx.toolCalls given), S2's claimGuard: a first-person
//      claim of a program change with no rec staged / no program write this turn
//      is replaced by one truthful line (AI contract rule 6)
// Returns {text, changed, removed, words}. MEASURE, never enforce: `words` is
// reported, nothing is ever truncated for length.
//
// NEVER run this on the ATHLETE's own text: their words are theirs. Every call
// site gates assistant/model output only.
//
// The server imports this through api/_voice.js (proof letters are gated before
// they are stored).

import { stripToolNameNoise } from "./chatRouting.js";
import { claimGuard } from "./replyGuards.js";

// Sentinel marking where a sentence-opening interjection was cut, so the next
// word can be capitalized ("Damn, sorry you got hit" -> "Sorry you got hit").
const CUT = "\u0001";

// ── banned words ────────────────────────────────────────────────────────────
// Decision (tested): "hell" is banned in every use, including "a hell of a lift"
// (rewritten to "a great lift"): Will's rule names "hell" outright. Word
// boundaries keep innocent words untouched: assess, class, classic, bass, pass,
// Hellenic, hello, shell, scrap, Dickens, cockpit, Sussex.
//
// Each rule: [regex, replacement]. Order matters: phrases before single words,
// interjections before intensifiers.
const PHRASES = [
  // "a hell of a lot" is just "a lot"; "one hell of a lift" is "a great lift"
  [/\b(?:a|one)\s+(?:hell|helluva|heck)\s+of\s+a\s+lot\b/gi, "a lot"],
  [/\b(?:a|one)\s+hell\s+of\s+an?\b/gi, "a great"],
  [/\b(?:a|one)\s+helluva\b/gi, "a great"],
  [/\b(?:hell|helluva)(?:\s+of)?\s+an?\b/gi, (m) => (/^H/.test(m) ? "A great" : "a great")],
  [/\bwhat\s+the\s+(?:hell|fuck|f)\b/gi, "what"],
  [/\bthe\s+(?:hell|fuck|shit|crap)\s+out\s+of\s+/gi, ""],
  [/\b(?:the\s+)?(?:hell|fuck)\s+(?=yeah\b|yes\b)/gi, ""],
  [/\bhurts?\s+like\s+hell\b/gi, (m) => (/^hurts/i.test(m) ? "hurts a lot" : "hurt a lot")],
  [/\blike\s+hell\b/gi, "a lot"],
  [/\bhalf[- ]?assed\b/gi, "half-hearted"],
  [/\bhalf[- ]?ass(?:ing)?\b/gi, (m) => (/ing$/i.test(m) ? "cutting corners on" : "cut corners on")],
  [/\b(?:shit|crap)\s+happens\b/gi, "it happens"],
  // integration (09-28): verb forms, euphemisms, initialisms and masked spellings
  [/\ba\s+(?:bitch|b[*@#$]+[a-z]*ch)\s+of\s+an?\b/gi, (m) => (/^A/.test(m) ? "A tough" : "a tough")],
  [/\bkick(ed|s|ing)?\s+ass\b/gi, (m, f) => (f === "ed" ? "crushed it" : f === "s" ? "crushes it" : f === "ing" ? "crushing it" : "crush it")],
  [/\bwtf\b(?=\s+[a-z])/gi, (m) => (/^W/.test(m) ? "What" : "what")],
  [/\b(?:a|one)\s+heck\s+of\s+an?\b/gi, "a great"],
  [/\bheck\s+of\s+an?\b/gi, (m) => (/^H/.test(m) ? "A great" : "a great")],
  [/\bno\s+bs\b/gi, (m) => (/^N/.test(m) ? "No nonsense" : "no nonsense")],
  [/\b(?:kick|bad)[- ]?ass(?:ery)?\b/gi, "strong"],
  [/\bpissed(?:\s+off)?\b/gi, "frustrated"],
  [/\bpiss(?:es|ing)?\s+(me|you|him|her|them)\s+off\b/gi, (m, who) => `${/^pissing/i.test(m) ? "frustrating" : /^pisses/i.test(m) ? "frustrates" : "frustrate"} ${who}`],
  [/\bbull\s?shit\b/gi, "nonsense"],
  [/\b(?:shitty|crappy|sucky)\b/gi, "rough"],
  [/\b(that|it|this)\s+(?:really\s+)?sucks\b/gi, (m, w) => `${w}'s rough`],
  [/\b(that|it|this)\s+(?:really\s+)?sucked\b/gi, (m, w) => `${w} was rough`],
  [/\bsucks\b/gi, "is rough"],
  [/\bsucked\b/gi, "was rough"],
  [/\bfuck(?:ed|ing)?\s+up\b/gi, (m) => (/ing/i.test(m) ? "messing up" : "messed up")],
  [/\bscrewed\s+up\b/gi, "messed up"],
  [/\bbitch(?:ing|ed)\b/gi, "complaining"],
  [/\b(?:a|the)\s+bitch\b/gi, "a pain"],
  [/\b(your|my|his|her|their)\s+ass(?:es)?\b/gi, (m, p) => ({ your: "yourself", my: "me", his: "him", her: "her", their: "them" })[p.toLowerCase()]],
  [/\b(the|this|that|some|your|my|same|good|old)\s+(?:shit|crap)\b/gi, "$1 stuff"],
];
// A sentence-opening (or standalone) interjection, followed by punctuation,
// the end, or a new sentence: cut it and let the next word open the sentence.
const INTERJ = "(?:holy|oh|aw|ah)\\s+(?:shit|crap|hell|fuck|damn)|dang(?:\\s+it)?|heck|god\\s*damn(?:\\s+it)?|goddamm?it|damn\\s+it|dammit|damn|shit|crap|hell|fuck(?:\\s+me)?|wtf|screw\\s+(?:it|that)|son\\s+of\\s+a\\s+bitch";
const INTERJ_RE = new RegExp(`(^|[.!?]\\s+|\\n[ \\t]*|,\\s*)(?:${INTERJ})\\b[ \\t]*(?:([,!.:;]+)|(?=\\n|$))[ \\t]*`, "gi");

// What is left: intensifiers and stray words. Removed with their trailing space.
const WORDS = [
  [/\b(?:god\s*damn(?:ed)?|damn(?:ed)?|fucking|fuckin'?|effing|effin'?|freaking|freakin'?|frickin[g']?|friggin[g']?|motherfucking)\s+(?=[a-z0-9])/gi, CUT],
  // masked spellings: b*tch, sh*t, f***, d@mn
  [/(?<![a-z0-9])(?:[a-z]+[*@#$]+[a-z]+[a-z*@#$]*|[a-z][*@#$]{2,})(?![a-z0-9])!*/gi, CUT],
  [/\b(?:dang|heck|bs)\b!*/gi, CUT],
  [/\b(?:shit|crap|fuck|fucked|fucker|damn|dammit|goddamn|hell|ass|asshole|bitch|wtf|bastard|motherfucker)\b!*/gi, CUT],
];

// Detection (for the report): any banned token at all.
const BANNED_RE = /\b(?:damn(?:ed|it)?|dammit|god\s*damn\w*|goddam+it|hell|helluva|crap(?:py)?|ass(?:es|hole|holes)?|badass|kick-?ass|half-?assed|shit(?:ty|s)?|bullshit|fuck(?:ed|ing|in|er|s)?|motherfuck\w*|bitch(?:es|ing|ed)?|pissed|piss(?:es|ing)?|sucks|sucked|sucky|screwed up|screw (?:it|that)|wtf|bastard)\b/i;

const BANNED_EXTRA_RE = /\b(?:dang|heck|bs|effin'?|freakin[g']?|frickin[g']?|friggin[g']?)\b|(?<![a-z0-9])(?:[a-z]+[*@#$]+[a-z]+[a-z*@#$]*|[a-z][*@#$]{2,})(?![a-z0-9])/i;
export const hasBannedWord = (text) => { const s = String(text || ""); return BANNED_RE.test(s) || BANNED_EXTRA_RE.test(s); };

function capAfterCut(s) {
  // capitalize the first letter after a cut at a sentence start
  return s
    .replace(new RegExp(`(^|[.!?]\\s+|\\n\\s*)${CUT}\\s*([a-z])`, "g"), (m, pre, ch) => pre + ch.toUpperCase())
    .replace(new RegExp(`${CUT}`, "g"), " ");
}

function tidy(s) {
  return s
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.!?;:])/g, "$1")          // "rough ," -> "rough,"
    .replace(/([,;:])\s*([.!?])/g, "$2")      // "rough, ." -> "rough."
    .replace(/,\s*,+/g, ",")                  // ",," -> ","
    .replace(/([.!?])\s*[,;:]\s*/g, "$1 ")    // ". , next" -> ". next"
    .replace(/^[ \t]*[,;:]\s*/gm, "")         // a line that now opens on a comma
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/^[ \t]+/gm, (m) => m)           // keep indentation (numbered lists)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// Recapitalize a sentence start the scrub lowercased ("sorry you got...") when
// the original sentence opened capitalized. Only positions we touched.
export function scrubProfanity(text) {
  const src = String(text ?? "");
  if (!src || !hasBannedWord(src)) return { text: src, removed: [] };
  const removed = [];
  const note = (m) => { removed.push(m.trim()); };
  let s = src;
  for (const [re, rep] of PHRASES) s = s.replace(re, (...args) => {
    note(args[0]);
    const out = typeof rep === "function" ? rep(...args) : args[0].replace(new RegExp(re.source, re.flags.replace("g", "")), rep);
    // keep a capital the match opened with ("Shit happens" -> "It happens")
    return /^[A-Z]/.test(args[0]) && out ? out.charAt(0).toUpperCase() + out.slice(1) : out;
  });
  s = s.replace(INTERJ_RE, (m, pre, punct = "") => {
    note(m);
    const end = (punct.match(/[.!?]/) || [""])[0];
    if (pre.trim() === ",") return end ? `${end} ` : ", ";   // "rough, damn." -> "rough."
    return `${pre}${CUT}`;                                   // sentence start: next word opens it
  });
  for (const [re, rep] of WORDS) s = s.replace(re, (m) => { note(m); return rep; });
  s = capAfterCut(s);
  s = tidy(s);
  // A sentence that became empty ("Damn." alone) leaves nothing behind.
  s = s.replace(/^[.!?]+\s*/gm, "").replace(/\s+([.!?])\1+/g, "$1");
  // A reply that was nothing BUT a banned word must not render as an empty bubble.
  if (!s.trim() && src.trim()) s = "Got it.";
  return { text: s, removed };
}

// Em dashes (and spaced en dashes / double hyphens used as dashes) become commas.
// Digit ranges ("3–5") are left alone.
export function normalizeDashes(text) {
  const src = String(text ?? "");
  if (!/—|\s–\s|\s--\s/.test(src)) return src;
  return tidy(src
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s+–\s+/g, ", ")
    .replace(/\s+--\s+/g, ", ")
    .replace(/^,\s*/gm, ""));
}

export const countWords = (text) => (String(text || "").trim().match(/[A-Za-z0-9][\w'’.%/-]*/g) || []).length;

// The gate. surface: a short label for the report ("chat", "chat_stream",
// "checkin", "proof_letter", "ql_note", "rec", "recap", "memory", "video_review",
// "builder", "change_request", "coach"). ctx.toolCalls (array) turns on the claim
// guard; ctx.appWrites = {program, rec} says what the app actually did this turn.
export function replyGate(surface, text, ctx = {}) {
  const input = String(text ?? "");
  const removed = [];
  let out = stripToolNameNoise(input);
  if (out !== input) removed.push("tool_names");
  const scrub = scrubProfanity(out);
  out = scrub.text;
  removed.push(...scrub.removed);
  out = normalizeDashes(out);
  if (Array.isArray(ctx.toolCalls)) {
    const g = claimGuard(out, { toolCalls: ctx.toolCalls, appWrites: ctx.appWrites || {} });
    if (g.changed) { out = g.text; removed.push(...g.removed.map((s) => `claim: ${s}`)); }
  }
  const report = { surface: String(surface || "unknown"), changed: out !== input, removed, words: countWords(out) };
  if (ctx.record !== false) recordGate(report);
  return { text: out, ...report };
}

// Just the clean string, for settle call sites.
export const gateText = (surface, text, ctx) => replyGate(surface, text, ctx).text;

// Render-time pass (every re-render, streaming frames, history rows persisted
// before the gate existed): same cleaning, never recorded.
export const renderGate = (text) => replyGate("render", text, { record: false }).text;

// Gate every string field of a model-returned object (rec title/why, change
// request suggestion). Non-strings pass through untouched.
export function gateFields(surface, obj, keys) {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  for (const k of keys) if (typeof out[k] === "string") out[k] = gateText(surface, out[k]);
  return out;
}

// Measurement without a server change: the last 100 reports ride on globalThis
// for QA drivers (the real-AI pass reads them); nothing is sent anywhere.
const RING = 100;
function recordGate(report) {
  try {
    if (typeof globalThis === "undefined" || report.surface === "chat_stream" || report.surface === "render") return;
    const buf = (globalThis.__WILCO_GATE__ ||= []);
    buf.push({ ...report, at: Date.now() });
    if (buf.length > RING) buf.splice(0, buf.length - RING);
  } catch { /* measurement must never throw */ }
}
