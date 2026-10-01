// ─── REPLY GUARDS — one voice per turn, no claimed action without the action ─
// T64 S2. Two pure pieces for AI contract rules 5 and 6.
//
// 1. arbitrateFollowUp: the app adds AT MOST ONE bubble per turn after Joe's
//    reply. The priority order lives in FOLLOWUP_PRIORITY below and nowhere
//    else; a lower-priority bubble is dropped (the caller logs it to
//    error_events with the reason), a higher-priority one replaces what showed.
//    Wired in App.jsx send()'s followUp.
//
// 2. claimGuard: finds first-person claims of a program change ("I'm pulling
//    front squat out of the rotation", "I've swapped", "I changed your program")
//    when the turn made no propose_program_rec call and no program write, and
//    replaces those sentences with one truthful line. PURE AND NOT WIRED HERE:
//    S4 wires it inside replyGate (src/replyGate.js) at every settle site.

// ── 1. follow-up arbiter ─────────────────────────────────────────────────────
// Lower rank wins. Action confirmations first (something really happened), then
// a choice the athlete must see to act on (a chip is waiting), then a question,
// then anything else.
export const FOLLOWUP_PRIORITY = Object.freeze({
  action_done: 0,
  choice: 1,
  question: 2,
  info: 3,
});

// Untagged call sites are classified from their own copy, so the table above
// stays the one place the order is written.
export function classifyFollowUp(note) {
  const t = String(note || "").trim();
  if (/Tap [“"]|\b[Ww]ant me to\b|\bWant it\b|\bsay the word\b/i.test(t)) return "choice";
  if (/^(📋|✅|✓|Swapped\b|Saved\b|Added\b|Drafted\b|Staged\b|Program saved\b|Temporary program cleared\b)/.test(t)) return "action_done";
  if (/\?\s*$/.test(t)) return "question";
  return "info";
}

// shown: the bubble already posted this turn ({kind}) or null.
// Returns "show" | "replace" | "drop".
export function arbitrateFollowUp(shown, kind) {
  const k = FOLLOWUP_PRIORITY[kind] != null ? kind : "info";
  if (!shown) return "show";
  const a = FOLLOWUP_PRIORITY[k];
  const b = FOLLOWUP_PRIORITY[shown.kind] != null ? FOLLOWUP_PRIORITY[shown.kind] : FOLLOWUP_PRIORITY.info;
  return a < b ? "replace" : "drop";
}

// ── 2. claim guard ───────────────────────────────────────────────────────────
export const TRUTHFUL_NO_CHANGE = "I haven't changed your program. Say the word and I'll draft it.";

const CHANGE_VERBS = "pull|pulling|swap|swapping|replac(?:e|ing)|remov(?:e|ing)|drop(?:ping)?|tak(?:e|ing)|cut(?:ting)?|mov(?:e|ing)|put(?:ting)?|chang(?:e|ing)|adjust(?:ing)?|add(?:ing)?|sub(?:bing)?|switch(?:ing)?|modify(?:ing)?|rework(?:ing)?|rewrit(?:e|ing)|scal(?:e|ing) back|deload(?:ing)?|program(?:ming)? in";
const PAST_VERBS = "swapped|changed|updated|pulled|removed|replaced|adjusted|dropped|added|moved|cut|switched|modified|rewritten|rewrote|reworked|put|subbed|taken|took|scaled back|deloaded|programmed";
// Words that tie a change verb to the program. S2b (09-28): "for now", "this
// week", "from your program" and a trailing "out" ("I took front squat out.")
// were missing, so past-tense claims slipped through.
const PROGRAMISH = /\b(program|rotation|block|plan|schedule|split|in its place|out of|for the rest|this week(?:'?s)?|next week|for now|monday|tuesday|wednesday|thursday|friday|saturday|sunday|day \d|week \d|going forward|from now on)\b|\bfor an?\b|\bwith an?\b|\bfor (?:a|the)\b|\bfrom (?:your|the|this)\b|\bout(?: for)?\b[.!]?\s*$/i;
// "swapped dips for push-ups": a swap naming its replacement is a program claim
const SWAP_FOR = /\b(swapp|replac|subb|switch)\w*\b[^.!?]*\bfor\b/i;
const NEGATED = /\b(not|nothing|never|no need|no reason|if you want|if you'd like|want me to|say the word|should i|could|would|i'?d)\b|n't\b/i;
const OFF_TOPIC = /\b(memory|remember|note|notes|log|logged|lock screen|card|reminder)\b/i;
// Verbs from the change list used for looking, not changing.
const DESCRIPTIVE = /\b(?:took|take|taking) a (?:look|peek|second|minute|glance)\b|\bpulled up\b|\bput together (?:a|your) (?:summary|recap)\b/i;

// ctx: true = the sentence must also tie the verb to the program (PROGRAMISH or
// a swap naming its replacement); false = the shape alone is a claim.
const CLAIM_RES = [
  { ctx: true, re: new RegExp(`\\b(?:i'?m|i am|we'?re|we are)\\s+(?:(?:going to|gonna|also|now|just)\\s+)?(?:${CHANGE_VERBS})\\b`, "i") },
  { ctx: true, re: new RegExp(`\\b(?:i'?ve|i have|we'?ve|we have|i|we)\\s+(?:(?:just|already|also|now|gone and|went ahead and)\\s+)?(?:${PAST_VERBS})\\b`, "i") },
  // a decision announced as done: "Let's drop front squats from your program going forward."
  { ctx: true, re: new RegExp(`\\blet'?s\\s+(?:just\\s+)?(?:${CHANGE_VERBS})\\b`, "i") },
  { ctx: false, re: /\b(?:your|the) (?:program|plan|block|schedule)\s+(?:is|has been|was|now)\s+(?:updated|changed|adjusted|rewritten|modified|reworked)\b/i },
  { ctx: false, re: /\bi'?ll (?:swap|pull|replace|remove|change|update|adjust|put|move|drop|sub|switch)\b[^.!?]*\b(?:program|rotation|block|in its place)\b/i },
  // "I'm staging a change", "I'm drafting a rec" with no rec staged this turn
  // bare past tense: "I staged a rec for that." (integration, 09-28)
  { ctx: false, re: /\bi\s+(?:just\s+)?(?:staged|drafted|queued|built|wrote|put together|set up|lined up|made)\s+(?:a|an|the|you a)\s+(?:protective\s+|small\s+|quick\s+)?(?:change|rec|recommendation|swap|adjustment|tweak|program change)\b/i },
  // no subject at all: "Front squat's out for now." / "Dips are out of the rotation."
  { ctx: false, re: /\b[a-z][\w' -]{2,40}?(?:'s| is| are)\s+out\s+(?:for now|for (?:the|this) (?:week|block)|of (?:the|your) (?:program|rotation|block|plan))\b/i },
  { ctx: false, re: /\b(?:i'?m|i am|i'?ve|i have)\s+(?:just\s+)?(?:staging|staged|drafting|drafted|putting together|put together|building|built|writing|written|queuing|queued|setting up|set up|lining up|lined up|making|made|putting in|working in|working up)\s+(?:a|an|the|you a)?\s*(?:protective\s+|small\s+|quick\s+|temporary\s+)?(?:change|changes|rec|recommendation|swap|adjustment|adjustments|modification|tweak|program change)\b/i },
];

// The clause around a match: from the previous clause break to the next one.
const CLAUSE_BREAK = /,|;|:|\bso\b|\bbut\b|\bbecause\b|\bsince\b|\bthat way\b/gi;
function claimClause(sentence, index, length) {
  let start = 0, end = sentence.length, m;
  CLAUSE_BREAK.lastIndex = 0;
  while ((m = CLAUSE_BREAK.exec(sentence))) {
    if (m.index + m[0].length <= index) start = m.index + m[0].length;
    else if (m.index >= index + length) { end = m.index; break; }
  }
  return sentence.slice(start, end);
}

export function findClaims(text) {
  const out = [];
  const paras = String(text || "").split(/\n{2,}/);
  paras.forEach((p, pi) => {
    const sents = p.split(/(?<=[.!?])\s+/);
    sents.forEach((s, si) => {
      const clean = s.replace(/[’]/g, "'");
      // a question is an offer, never a claim
      if (OFF_TOPIC.test(clean) || DESCRIPTIVE.test(clean) || /\?\s*$/.test(clean)) return;
      // Negation and hedging are judged on the CLAUSE that holds the claim, not
      // the whole sentence: "I'm setting up an adjustment so we're not stacking
      // more onto it" is a claim, and its "not" belongs to the reason after it.
      const hit = CLAIM_RES.some(({ re, ctx }) => {
        const m = re.exec(clean);
        if (!m) return false;
        if (ctx && !(PROGRAMISH.test(clean) || SWAP_FOR.test(clean))) return false;
        return !NEGATED.test(claimClause(clean, m.index, m[0].length));
      });
      if (hit) out.push({ para: pi, sent: si, text: s });
    });
  });
  return out;
}

// toolCalls: the turn's mastermind tool calls ([{name, input}]).
// appWrites: {program: bool} when the app wrote the program this turn.
// Returns {text, changed, removed: [sentences]}.
export function claimGuard(replyText, { toolCalls = [], appWrites = {} } = {}) {
  const text = String(replyText || "");
  const acted = (toolCalls || []).some((tc) => tc && tc.name === "propose_program_rec") || !!(appWrites && (appWrites.program || appWrites.rec));
  if (acted || !text) return { text, changed: false, removed: [] };
  const claims = findClaims(text);
  if (!claims.length) return { text, changed: false, removed: [] };
  const paras = text.split(/\n{2,}/).map((p) => p.split(/(?<=[.!?])\s+/));
  let placed = false;
  for (const c of claims) {
    paras[c.para][c.sent] = placed ? null : TRUTHFUL_NO_CHANGE;
    placed = true;
  }
  const out = paras
    .map((sents) => sents.filter((s) => s !== null).join(" ").trim())
    .filter(Boolean)
    .join("\n\n");
  return { text: out, changed: true, removed: claims.map((c) => c.text) };
}

// ── 3. turn guards (T67, 09-29): facts Joe was told not to state ─────────────
// Measured on shipped code with the real model: the rule was in his context and
// he still slipped now and then. Each guard enforces a fact the app already
// computed for the turn, on the sentence that breaks it. Nothing else is touched.
//   painCountGuard   a count about pain ("that's the second time that knee's
//                    flared up"). AI contract: Joe never states a count the app
//                    did not hand him, and the pain ledger hands him none.
//   unitRestateGuard a sentence restating a load whose unit the app is asking
//                    about (prAttempts unitCheckFact: "do not restate its weight")
//   repWordGuard     single/double/triple where no logged set had that many reps
//                    (PERFORMED: "never a rep word its numbers do not say")
// Structure is kept: paragraphs, lines (numbered lists) and sentence order.

const splitReply = (text) => String(text || "").split(/\n{2,}/).map((p) => p.split("\n").map((l) => l.split(/(?<=[.!?])\s+/)));
const joinReply = (paras) => paras
  .map((lines) => lines.map((sents) => sents.filter((s) => s !== null).join(" ").trim()).filter(Boolean).join("\n"))
  .filter(Boolean)
  .join("\n\n");
// Drop every sentence the test flags; never empty a reply (then keep it whole).
function dropSentences(text, test) {
  const src = String(text || "");
  const paras = splitReply(src);
  const removed = [];
  paras.forEach((lines) => lines.forEach((sents) => sents.forEach((s, i) => { if (s && test(s)) { removed.push(s); sents[i] = null; } })));
  if (!removed.length) return { text: src, changed: false, removed };
  const out = joinReply(paras);
  if (!out.trim()) return { text: src, changed: false, removed: [] };
  return { text: out, changed: true, removed };
}

// A pain word always counts; a body part counts only when it is an area the
// pain ledger holds for this turn ("second session back" is not about pain).
const PAIN_WORDS = /\b(pain|painful|hurts?|hurting|sore|soreness|ach(?:e|es|y|ing)|flare[sd]?|flaring|flare-?ups?|tweak(?:ed|y)?|niggl\w*|irritat\w*|injur\w*)\b/i;
const PAIN_COUNT = /\b(?:second|third|fourth|fifth|2nd|3rd|4th|5th)\s+(?:time|day|session|mention|week|straight)\b|\btwice\b|\b(?:two|three|four|\d+)\s+(?:times|days|sessions)\s+(?:in a row|straight|running|now)\b|\b(?:two|three|four|\d+)\s+times\b|\bback[- ]to[- ]back\b|\bkeeps? (?:coming|showing) up\b/i;
const areaWords = (areas) => (Array.isArray(areas) ? areas : []).flatMap((a) => String(a || "").toLowerCase().split(/[_\s]+/)).filter((w) => w.length > 2 && !["left", "right", "lower", "upper", "front", "rear"].includes(w));
export const statesPainCount = (sentence, areas = []) => {
  if (!PAIN_COUNT.test(sentence)) return false;
  if (PAIN_WORDS.test(sentence)) return true;
  return areaWords(areas).some((w) => new RegExp(`\\b${w}s?\\b`, "i").test(sentence));
};
// areas: the pain ledger's areas for this turn (painTurn.turn.areas), may be empty.
export function painCountGuard(text, areas = []) {
  return dropSentences(text, (s) => statesPainCount(s, areas));
}

// loads: [{weight}] pending a unit answer this turn.
// performed: the turn's settled lifts; a number one of them also carries is left alone.
export function unitRestateGuard(text, loads = [], performed = []) {
  const settled = new Set((Array.isArray(performed) ? performed : []).flatMap((e) => [e?.weight, ...(Array.isArray(e?.set_details) ? e.set_details.map((s) => s?.weight) : [])]).map(Number));
  const nums = (Array.isArray(loads) ? loads : []).map((l) => Number(l && l.weight)).filter((n) => Number.isFinite(n) && n > 0 && !settled.has(n));
  if (!nums.length) return { text: String(text || ""), changed: false, removed: [] };
  const res = nums.map((n) => new RegExp(`(?<![\\d.])${String(n).replace(".", "\\.")}(?![\\d])`));
  // A question stays: Joe asking about the unit himself is the designed path
  // (prAttempts replyAsksUnit: the app then does not ask a second time).
  return dropSentences(text, (s) => !/\?\s*$/.test(s.trim()) && res.some((re) => re.test(s)));
}

// performed: this message's logged exercises ({set_details|reps}). A rep word is
// rewritten only when no logged set had that rep count; the noun stays a set.
const REP_WORD_N = { single: 1, double: 2, triple: 3 };
// the word as a noun for a set: not single-leg, double-check, triple extension, "a single session"
const REP_WORD_RE = /\b(single|double|triple)(s?)\b(?![- ](?:leg|arm|arms|legs|day|days|session|sessions|rep|reps|set|sets|digit|digits|check|checked|extension|time|times|out|file|handed|the|that|it|down|up))/gi;
export function repWordGuard(text, performed = []) {
  const src = String(text || "");
  const reps = new Set();
  for (const ex of Array.isArray(performed) ? performed : []) {
    const sets = Array.isArray(ex?.set_details) && ex.set_details.length ? ex.set_details : [{ reps: ex?.reps }];
    for (const s of sets) if (Number(s?.reps) > 0) reps.add(Number(s.reps));
  }
  if (!reps.size) return { text: src, changed: false, removed: [] };
  const removed = [];
  const out = src.replace(REP_WORD_RE, (m, w, pl, off, all) => {
    const n = REP_WORD_N[w.toLowerCase()];
    if (reps.has(n)) return m;
    if (/\bnot a\s*$/i.test(all.slice(Math.max(0, off - 8), off))) return m; // "not a single"
    // an estimate's "single" is a 1RM, not a logged set ("about 101 kg for a single")
    const around = all.slice(Math.max(0, all.lastIndexOf(".", off) + 1), (all.indexOf(".", off) + 1 || all.length));
    if (/\b(estimat\w*|e1rm|1rm|max(?:es)?|PR|projects?|worth)\b/i.test(around)) return m;
    removed.push(m);
    const rep = pl ? "sets" : "set";
    return /^[A-Z]/.test(w) ? rep[0].toUpperCase() + rep.slice(1) : rep;
  });
  return { text: out, changed: out !== src, removed };
}

// planRestGuard (T67, prod pass 09-29): the deployed client still got "barbell
// rows and pull-ups whenever you get to them" on 4 of 5 partial logs; the fact
// in LOG REPLY FOCUS shortened it to a clause and did not remove it. The turn's
// planRest (turnFacts logHeadline: today's planned lifts this log leaves out,
// empty whenever the app asks its one skipped-lift question) is enforced here:
// a sentence naming one of them goes. Never when the athlete asked something in
// the same message (an answer they asked for is never limited).
const headNoun = (name) => String(name || "").toLowerCase().replace(/\([^)]*\)/g, " ").trim().split(/\s+/).pop().replace(/[^a-z-]/g, "").replace(/s$/, "");
const nameRe = (words) => new RegExp(`\\b${words.map((w) => w.replace(/-/g, "[- ]?")).join("[- ]+")}s?\\b`, "i");
export function planRestGuard(text, planRest = [], { performed = [], asked = false } = {}) {
  const src = String(text || "");
  const rest = (Array.isArray(planRest) ? planRest : []).filter(Boolean);
  if (!rest.length || asked) return { text: src, changed: false, removed: [] };
  const loggedHeads = new Set((Array.isArray(performed) ? performed : []).map((e) => headNoun(e?.name)).filter(Boolean));
  const res = rest.map((name) => {
    const words = String(name).toLowerCase().replace(/\([^)]*\)/g, " ").trim().split(/\s+/).map((w) => w.replace(/[^a-z-]/g, "")).filter(Boolean);
    if (!words.length) return null;
    words[words.length - 1] = words[words.length - 1].replace(/s$/, "");
    const head = words[words.length - 1];
    // "Romanian Deadlift" left out of a log that holds "Deadlift": only the full name counts
    return loggedHeads.has(head) || head.length < 3 ? nameRe(words) : nameRe([head]);
  }).filter(Boolean);
  return dropSentences(src, (sent) => !/\?\s*$/.test(sent.trim()) && res.some((re) => re.test(sent)));
}
