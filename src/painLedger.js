// ─── PAIN LEDGER — the one home for pain state (T64 S2) ─────────────────────
// Will, 09-28: the app raised pain too often and drafted too many program
// changes. A pain mention is noted once and tracked silently. The ledger records
// WHEN an area was mentioned and TO WHAT DEGREE, counts clean sessions as
// recovery evidence, clears areas on its own as they improve, reopens them when
// they flare, and tells every surface whether to speak. The AI is no doctor:
// this is internal bookkeeping so Joe knows when to talk and when to track.
//
// Pure: rows in, verdicts out. No React, no network. Every surface that shows or
// talks about pain reads this module (chat context, follow-up gate, check-in,
// proof letter via api/_painLedger.js, coach views, MY LOG).
//
// Contract (docs/AI-CONTRACT.md rule 11): facts come from here, final. Joe never
// counts mentions, names dates or describes a pattern beyond what `summary` says.

import { resolveLift, getExerciseSets, isRealSession } from "./grit.js";
import { toKg } from "./units.js";

// ── thresholds (every number the ledger uses, one line of reason each) ──────
export const DAY_MS = 86400000;
export const EPISODE_GAP_DAYS = 28;     // 4 quiet weeks and a new mention is a new episode, not the old one
export const WINDOW_DAYS = 14;          // "recent": mentions14d, serious window, offer cooldown (Will: quiet 14 days after an offer)
export const ACTIVE_SEV3_DAYS = 7;      // a session-changing report stays active for a week on its own
export const EASING_QUIET_DAYS = 7;     // a week without a mention plus one clean session reads as easing
export const QUIET_DAYS = 14;           // two weeks without a mention...
export const QUIET_CLEAN = 3;           // ...and three clean sessions reads as quiet
export const QUIET_ANY_DAYS = 21;       // three weeks silent is quiet even without logged evidence
export const CLEARED_DAYS = 28;         // four weeks silent: cleared (matches the episode gap)
export const CLEARED_CLEAN = 6;         // six clean sessions since the last mention: cleared
export const CLEAN_LOAD_FRACTION = 0.85;// a session proves recovery only near the load that hurt
export const FAMILY_BEST_LOOKBACK_DAYS = 56; // a family lift counts at 85% of the athlete's own recent best on it
export const OFFER_COOLDOWN_DAYS = 14;  // one offer, then quiet on that area for 14 days (Will 09-28)
export const DECLINES_TO_STOP_ASKING = 2; // two explicit "no" to the protective-change question stops THAT question
export const RECORD_HORIZON_DAYS = 56;  // a closed episode stays visible (as cleared) for 8 weeks, then drops off

// Severity scale, defined once.
export const SEV_AWARE = 1;    // tight, slight, "a very small amount"
export const SEV_DULL = 2;     // dull, lingering, flaring, "feeling it"
export const SEV_CHANGED = 3;  // changed or cut the session: "on fire", "stopped early", "had to drop the weight"
export const SEV_SERIOUS = 4;  // sharp, sudden, pop, gave out, numbness, could not bear weight
export const SEVERITY_WORDS = { 1: "mild", 2: "dull or lingering", 3: "bad enough to change the session", 4: "serious" };

export const STATES = ["serious", "new", "active", "easing", "quiet", "cleared"];
export const SPEAK = ["none", "acknowledge_once", "offer_change_once", "address_now"];

// ── area taxonomy (the resolveLift of body parts) ────────────────────────────
// Order matters: specific phrases before the words they contain ("lower back"
// before "back", "hip flexor" before "hip", "shin splints" before "shin").
const AREA_TABLE = [
  ["it_band", /\b(it[- ]?band|itb|iliotibial)\b/],
  ["achilles", /\b(achill[ei]e?s|archill[ei]e?s|achilies)\b/],
  ["upper_back", /\b(upper[- ]?back|mid[- ]?back|thoracic|rhomboids?|traps?|trapezius|lats?|latissimus|shoulder ?blades?|scapula)\b/],
  ["low_back", /\b(low(er)?[- ]?back|lumbar|si[- ]joint|sacroiliac|sacrum|erectors?|ql|quadratus|tailbone|back)\b/],
  ["neck", /\b(neck|cervical)\b/],
  ["pec", /\b(pecs?|peck|pectorals?|pectoralis|chest|sternum)\b/],
  ["shoulder", /\b(shoulders?|sholders?|shoudlers?|rotator ?cuff|supraspinatus|infraspinatus|labrum|ac joint|delts?|deltoids?)\b/],
  ["elbow", /\b(elbows?|tennis elbow|golfer'?s elbow|tricep(s)? tendon|olecranon)\b/],
  ["wrist", /\b(wrists?|carpal)\b/],
  ["forearm", /\b(forearms?|brachioradialis)\b/],
  ["groin", /\b(groin|adductors?|inner thigh)\b/],
  ["hip", /\b(hips?|hip flexors?|psoas|iliopsoas)\b/],
  ["glute", /\b(glutes?|gluteus|butt|piriformis)\b/],
  ["hamstring", /\b(hamstrings?|hamstrngs?|hammys?|hammies)\b/],
  ["quad", /\b(quads?|quadriceps?|quadraceps?|quadracep)\b/],
  ["knee", /\b(knees?|kneee?s?|patell(a|ar)|patellar tendon|acl|mcl|lcl|pcl|meniscus|kneecaps?)\b/],
  ["calf", /\b(calf|calves|calfs|soleus|gastrocs?|gastrocnemius)\b/],
  ["shin", /\b(shins?|shin splints|tibia)\b/],
  ["ankle", /\b(ankles?)\b/],
  ["foot", /\b(foot|feet|plantar|heels?|arch(es)?|toes?)\b/],
];
const AREA_LABELS = {
  it_band: "IT band", achilles: "Achilles", low_back: "low back", upper_back: "upper back", neck: "neck",
  pec: "pec", shoulder: "shoulder", elbow: "elbow", wrist: "wrist", forearm: "forearm", groin: "groin",
  hip: "hip", glute: "glute", hamstring: "hamstring", quad: "quad", knee: "knee", calf: "calf",
  shin: "shin", ankle: "ankle", foot: "foot",
};
export const AREA_KEYS = AREA_TABLE.map(([k]) => k);

const clean = (s) => String(s || "").toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' /-]+/g, " ").replace(/\s+/g, " ").trim();

const sideOf = (t) => {
  const left = /\bleft\b|\blt\b/.test(t), right = /\bright\b|\brt\b/.test(t);
  if (left && right) return "both";
  if (left) return "left";
  if (right) return "right";
  if (/\b(both|knees|shoulders|elbows|wrists|ankles|hips|calves|shins|feet|hamstrings|quads)\b/.test(t)) return "both";
  return null;
};

// One text -> one canonical area {key, side, label}. Unknown text falls back to
// a cleaned lowercase string so it still groups with itself.
export function normArea(text) {
  const t = clean(text).replace(LIFT_PHRASES, " ").replace(/\s+/g, " ").trim() || clean(text);
  if (!t) return { key: "", side: null, label: "" };
  for (const [key, re] of AREA_TABLE) {
    if (re.test(t)) {
      // "toes to bar" is a lift, not a foot
      if (key === "foot" && /\btoes? to bar\b/.test(t) && !/\b(foot|feet|heel|arch|plantar)\b/.test(t)) continue;
      return { key, side: sideOf(t), label: AREA_LABELS[key] };
    }
  }
  const fallback = t.replace(/\b(my|the|a|an|left|right|both)\b/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return { key: fallback, side: sideOf(t), label: fallback };
}
export const areaLabel = (key) => AREA_LABELS[key] || String(key || "");

// Every known area named in a free text ("knees flared, and my pec too" -> knee, pec).
// Lift names that contain body words ("back squat", "chest-supported row") are
// not areas; strip them before scanning free text.
const LIFT_PHRASES = /\b(toes? to bar|back squats?|back extensions?|back raises?|hip thrusts?|hip mobility|hip (ab|ad)ductors?|knee extensions?|terminal knee|calf raises?|shoulder press(es)?|leg press(es)?|chest[- ]?supported|chest press|neck bridges?|behind the neck|wrist curls?|knees? to (elbow|chest)|hanging knee raises?)\b/g;
export function areasInText(text) {
  let t = ` ${clean(text).replace(LIFT_PHRASES, " ")} `;
  const out = [];
  for (const [key, re] of AREA_TABLE) {
    const g = new RegExp(re.source, "g");
    if (g.test(t)) {
      if (!out.includes(key)) out.push(key);
      t = t.replace(new RegExp(re.source, "g"), " "); // "upper back" must not also read as "back"
    }
  }
  return out;
}

// ── classifier: the fallback reader for every OLD row (no parser fields) ─────
const PAIN_WORDS = /\b(pain|painful|hurt|hurts|hurting|ache|aches|aching|achy|tweak|tweaked|strain|strained|sprain|flar|flare|flared|flaring|twinge|sharp|pinch|pinched|burn|burning|on fire|irritat\w*|inflam\w*|throb\w*|injur\w*|barking|talking|felt it|feel it|feeling it|felt my|bother\w*|discomfort|sore spot|numb\w*|tingl\w*|popped|pop\b|gave out)/;
const SORENESS_WORDS = /\b(sore|soreness|doms|tired|fatigued?|exhausted|beat up|beat|wiped|drained|stiff)\b/;
const SEV4_RE = /\b(sharp|shooting|stabbing|popp?ed|pop\b|gave out|giving out|buckled|numb\w*|tingl\w*|can'?t (bear|put) weight|couldn'?t (walk|bear|put weight|move)|can'?t (walk|move)|tore|torn|rupture\w*|dislocat\w*|sudden(ly)?|out of nowhere|swollen|swelling|heard a|went out)\b/;
const SEV3_RE = /\b(took (the )?(rest|day|days|week)[a-z0-9 ]{0,20} off|to heal|stopped|stop early|stopped early|had to (stop|drop|cut|bail|skip|quit)|cut (it|the session|the set|things) short|cut the session|only did|dropp?(ed)? the weight|had to go lighter|couldn'?t finish|could not finish|on fire|bail(ed)?|pretty significant|significant|really hurt\w*|preventing|prevent\w*|killing|assisted because|too much pain|pulled out|shut it down|called it)\b/;
const SEV1_RE = /\b(very small|small amount|a (little|bit|touch)|slight(ly)?|tight|tightness|minor|barely|niggle|twinge|a hint|mild(ly)?)\b/;
const CLEARED_RE = /\b(feels? (great|fine|good|normal|100|better now)|feel(ing)? (great|fine|good|normal) now|no (more )?pain|pain[- ]free|all good now|cleared( up)?|healed|gone now|doesn'?t hurt|don'?t feel it|not bothering)\b/;
const PRECAUTION_RE = /\b(save|saving|protect\w*|avoid\w*|precaution\w*|just in case|to be safe)\b/;

const clauseFor = (message, words) => {
  const parts = String(message || "").split(/\n|(?<=[.!?;])\s+/);
  const hits = parts.filter((p) => words.some((w) => w && clean(p).includes(w)));
  return hits.join(" ");
};

// Extract the lift a pain was felt during, from "during X" / "on X" / a lift word.
const DURING_STOP = /\b(volume|work|sets?|day|session|today|yesterday|again|stopped|early|and|so|because|but|possible|continued|due|with)\b.*$/;
const LIFTISH = /(squat|press|bench|pull|row|dip|deadlift|clean|snatch|jerk|lunge|curl|raise|extension|jump|run|sprint|fly|thrust|push)/;
const LIFT_WORD_RE = /\b((?:front |back |overhead |box |split |goblet |bulgarian split )?squat|(?:incline |decline |close grip )?(?:dumbbell |db )?bench(?: press)?|overhead press|push press|strict press|deadlift|rdl|clean(?: and jerk)?|snatch|jerk|lunges?|dips?|pull[- ]?ups?|rows?|curls?)\b/;
export function extractDuring(text) {
  // work clause by clause so "during bench press, possible strain" stops at the comma
  const clauses = String(text || "").toLowerCase().split(/[,;.()!?\n]+/).map(clean).filter(Boolean);
  for (const c of clauses) {
    const m = c.match(/\binstead of\s+((?:[a-z&+'-]+\s?){1,4})/) || c.match(/\b(?:during|while doing|while)\s+((?:[a-z&+'-]+\s?){1,6})/) || c.match(/\b(?:doing|on my|on)\s+(?!fire\b)((?:[a-z&+'-]+\s?){1,6})/);
    if (!m) continue;
    const phrase = m[1].replace(DURING_STOP, "").replace(/\b(to|from|the|my|a)\b.*$/, "").trim();
    if (phrase && LIFTISH.test(phrase)) { const lw = phrase.match(LIFT_WORD_RE); return lw && lw[1] !== phrase ? (phrase.length > 30 ? lw[1] : phrase) : phrase; }
  }
  for (const c of clauses) { const m = c.match(LIFT_WORD_RE); if (m) return m[1]; }
  return null;
}

export function classifyPain({ description = "", message = "", area = "" } = {}) {
  const areaKey = normArea(area).key;
  const words = [clean(area), areaKey, ...(areaKey ? [AREA_LABELS[areaKey] || ""] : [])].filter(Boolean).map((w) => w.split(" ")[0].replace(/s$/, ""));
  const clause = clauseFor(message, words);
  const d = clean(description);
  const all = `${d} ${clean(clause)}`.trim();
  const status = CLEARED_RE.test(d) && !/\b(still|again|but)\b/.test(d) ? "cleared" : null;
  const painy = PAIN_WORDS.test(all);
  const soreness = !painy && SORENESS_WORDS.test(all);
  let severity = SEV_DULL;
  if (SEV4_RE.test(all)) severity = SEV_SERIOUS;
  else if (SEV3_RE.test(all)) severity = SEV_CHANGED;
  else if (SEV1_RE.test(all)) severity = SEV_AWARE;
  else if (PRECAUTION_RE.test(all)) severity = SEV_DULL;
  const character = /\bsharp|shooting|stabbing\b/.test(all) ? "sharp"
    : /\bon fire|burn/.test(all) ? "burning"
    : /\btight/.test(all) ? "tight"
    : /\bflar/.test(all) ? "flaring"
    : /\bdull|ache|aching|achy|lingering/.test(all) ? "dull"
    : null;
  const onset = /\b(sudden(ly)?|popp?ed|pop\b|out of nowhere|gave out|went out|heard a)\b/.test(all) ? "sudden" : "gradual";
  return {
    kind: soreness ? "soreness" : "pain",
    severity,
    character,
    onset,
    stoppedSession: severity >= SEV_CHANGED && SEV3_RE.test(all),
    during: extractDuring(d) || extractDuring(clause),
    status,
  };
}

// Serious language in a raw message, before the parser runs (chat streams first).
export const isSeriousText = (text) => SEV4_RE.test(clean(text));

// ── dates ────────────────────────────────────────────────────────────────────
const dtfCache = new Map();
export function dayKey(v, tz) {
  const d = v instanceof Date ? v : new Date(typeof v === "string" && /^\d{4}-\d{2}-\d{2} \d/.test(v) ? v.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? "" : "Z") : v);
  if (isNaN(d.getTime())) return null;
  const k = tz || "";
  if (!dtfCache.has(k)) dtfCache.set(k, new Intl.DateTimeFormat("en-CA", { timeZone: tz || undefined, year: "numeric", month: "2-digit", day: "2-digit" }));
  return dtfCache.get(k).format(d);
}
const keyMs = (k) => Date.parse(k + "T00:00:00Z");
export const daysBetween = (a, b) => Math.round((keyMs(b) - keyMs(a)) / DAY_MS);
const addDays = (k, n) => new Date(keyMs(k) + n * DAY_MS).toISOString().slice(0, 10);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDay = (k) => (k ? `${MONTHS[+k.slice(5, 7) - 1]} ${+k.slice(8, 10)}` : "");

const pdOf = (w) => (typeof w?.parsed_data === "string" ? (() => { try { return JSON.parse(w.parsed_data); } catch { return {}; } })() : (w?.parsed_data || {}));
export const rowDay = (w, tz) => {
  const ld = pdOf(w).log_date;
  if (ld && /^\d{4}-\d{2}-\d{2}$/.test(ld)) return ld;
  return dayKey(w?.created_at, tz);
};

// ── movement families: which lifts load an area ──────────────────────────────
export const AREA_FAMILIES = {
  knee: /squat|lunge|step[- ]?up|leg press|pistol|jump|bound|sprint|\brun/,
  pec: /bench|push[- ]?up|\bdips?\b|\bfly|flye|chest press|floor press/,
  shoulder: /overhead press|shoulder press|military|push press|jerk|snatch|arnold|handstand|lateral raise|strict press|\bohp\b|z press|bottoms[- ]?up/,
  elbow: /curl|tricep|pushdown|skull|\bdips?\b|chin[- ]?up|pull[- ]?up/,
  wrist: /clean|front squat|curl|bench|push[- ]?up|jerk/,
  forearm: /curl|clean|deadlift|row|pull[- ]?up|chin[- ]?up|carry/,
  low_back: /deadlift|\brdl\b|good morning|back squat|clean|snatch|\bpull\b|row|back extension|hyperextension/,
  upper_back: /row|pull[- ]?up|chin[- ]?up|pulldown|shrug|deadlift|clean|snatch/,
  neck: /shrug|squat|carry/,
  hip: /squat|deadlift|lunge|hip thrust|bridge|split|step[- ]?up/,
  groin: /squat|sumo|lunge|adductor|copenhagen/,
  glute: /squat|deadlift|hip thrust|bridge|lunge|\brdl\b/,
  hamstring: /deadlift|\brdl\b|good morning|leg curl|sprint|nordic|clean|snatch/,
  quad: /squat|lunge|leg press|leg extension|step[- ]?up/,
  it_band: /\brun|squat|lunge/,
  calf: /\brun|sprint|jump|calf raise|skip/,
  achilles: /\brun|sprint|jump|bound|skip/,
  shin: /\brun|sprint|jump/,
  ankle: /\brun|sprint|jump|squat|lunge/,
  foot: /\brun|sprint|jump/,
};

const topWorkingKg = (ex) => {
  if (!ex || ex.unit === "bodyweight") return 0;
  const sets = getExerciseSets(ex).filter((s) => !s.warmup && s.weight > 0);
  const all = sets.length ? sets : getExerciseSets(ex).filter((s) => s.weight > 0);
  return all.reduce((m, s) => Math.max(m, toKg(Number(s.weight) || 0, ex.unit === "kg" ? "kg" : "lbs")), 0);
};
const exNorm = (name) => clean(name).replace(/\bdb\b/g, "dumbbell");

// ── events + sessions from rows ──────────────────────────────────────────────
// Rows may be real logs or chat rows; pain lives in parsed_data.pain_flags.
// Parser fields (severity/character/onset/during/status) win over the classifier.
export function extractEvents(rows, { tz, checkIns = [] } = {}) {
  const events = [];
  for (const w of rows || []) {
    const pd = pdOf(w);
    const flags = Array.isArray(pd.pain_flags) ? pd.pain_flags : [];
    if (!flags.length) continue;
    const day = rowDay(w, tz);
    if (!day) continue;
    const at = Date.parse(w.created_at) || keyMs(day);
    for (const f of flags) {
      if (!f || !f.area) continue;
      const a = normArea(f.area);
      if (!a.key) continue;
      const c = classifyPain({ description: f.description, message: w.raw_message, area: f.area });
      const status = f.status === "cleared" ? "cleared" : (f.status ? null : c.status);
      if (status === "cleared") { events.push({ type: "cleared", day, at, area: a.key, side: a.side, source: "log", rowId: w.id }); continue; }
      if (c.kind === "soreness" && !f.severity) continue; // normal training soreness is not pain
      const sev = [1, 2, 3, 4].includes(+f.severity) ? +f.severity : c.severity;
      events.push({
        type: "mention", day, at, area: a.key, side: a.side, label: a.label,
        severity: sev,
        character: f.character || c.character,
        onset: f.onset || c.onset,
        stoppedSession: sev >= SEV_CHANGED && (c.stoppedSession || sev >= SEV_CHANGED),
        during: f.during || c.during || null,
        description: String(f.description || "").slice(0, 160),
        rowId: w.id,
        source: isRealSession(w) ? "log" : "chat",
      });
    }
  }
  for (const ci of checkIns || []) {
    const a = normArea(ci.area);
    const day = ci.day || dayKey(ci.at, tz);
    if (!a.key || !day) continue;
    const at = Date.parse(ci.at) || keyMs(day);
    if (ci.status === "cleared") events.push({ type: "cleared", day, at, area: a.key, side: a.side, source: "checkin" });
    else if (ci.status === "lingering" || ci.status === "sharp") {
      events.push({ type: "mention", day, at, area: a.key, side: a.side, label: a.label, severity: ci.status === "sharp" ? SEV_CHANGED : SEV_DULL, character: ci.status === "sharp" ? "sharp" : "dull", onset: "gradual", stoppedSession: false, during: null, description: `check-in: ${ci.status}`, source: "checkin" });
    }
  }
  return events.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : x.at - y.at));
}

export function extractSessions(rows, { tz } = {}) {
  const byDay = new Map();
  for (const w of rows || []) {
    if (!isRealSession(w)) continue;
    const day = rowDay(w, tz);
    if (!day) continue;
    const list = byDay.get(day) || [];
    for (const ex of pdOf(w).exercises || []) {
      if (!ex || !ex.name) continue;
      list.push({ id: resolveLift(ex.name).id, norm: exNorm(ex.name), kg: topWorkingKg(ex), bodyweight: ex.unit === "bodyweight" });
    }
    byDay.set(day, list);
  }
  return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, lifts]) => ({ day, lifts }));
}

// The load in use when it hurt: the `during` lift in that day's session (or the
// previous day's, for a chat note sent after midnight about last night's work).
function painLoads(areaEvents, sessions) {
  const out = []; // {id, norm, kg, bodyweight}
  for (const e of areaEvents) {
    if (e.type !== "mention" || !e.during) continue;
    const dNorm = exNorm(e.during).replace(/\bpress\b$/, "").trim();
    const dId = resolveLift(e.during).id;
    const cands = sessions.filter((s) => s.day === e.day || s.day === addDays(e.day, -1)).reverse();
    let hit = null;
    for (const s of cands) {
      hit = s.lifts.find((l) => l.id === dId) || s.lifts.find((l) => dNorm && l.norm.includes(dNorm));
      if (hit) break;
    }
    if (hit) out.push({ id: hit.id, norm: hit.norm, kg: hit.kg, bodyweight: hit.bodyweight || !(hit.kg > 0), day: e.day });
    else out.push({ id: dId, norm: exNorm(e.during), kg: 0, bodyweight: false, unknownLoad: true, day: e.day });
  }
  return out;
}

// Did this session train the area hard enough to count as recovery evidence?
function sessionTrainsArea(session, area, loads, sessions) {
  const fam = AREA_FAMILIES[area];
  const latestLoad = (id) => { for (let i = loads.length - 1; i >= 0; i--) if (loads[i].id === id && loads[i].kg > 0) return loads[i]; return null; };
  const anyLoaded = loads.some((l) => l.kg > 0);
  for (const l of session.lifts) {
    // 1. a lift the pain was felt during (or a complex containing it; an
    // incline DB bench is NOT a barbell bench, so plain name containment is not enough)
    const isComplex = /\+|\bcomplex\b/.test(l.norm);
    const direct = latestLoad(l.id) || (isComplex ? loads.filter((p) => p.kg > 0 && p.norm && l.norm.includes(p.norm)).pop() : null);
    if (direct) { if (l.kg >= CLEAN_LOAD_FRACTION * direct.kg) return true; continue; }
    // 2. a lift in the area's movement family
    if (!fam || !fam.test(l.norm)) continue;
    if (l.bodyweight || !(l.kg > 0)) { if (!anyLoaded) return true; continue; }
    let best = 0;
    for (const s of sessions) {
      if (s.day >= session.day || daysBetween(s.day, session.day) > FAMILY_BEST_LOOKBACK_DAYS) continue;
      for (const x of s.lifts) if (x.id === l.id) best = Math.max(best, x.kg);
    }
    if (!best || l.kg >= CLEAN_LOAD_FRACTION * best) return true;
  }
  return false;
}

// ── the record for one area ──────────────────────────────────────────────────
const clearTimes = (areaEvents, mark) => {
  const t = areaEvents.filter((e) => e.type === "cleared").map((e) => ({ day: e.day, at: e.at, source: e.source }));
  if (mark && mark.cleared_at) {
    const at = Date.parse(mark.cleared_at);
    if (Number.isFinite(at)) t.push({ day: mark.cleared_day || null, at, source: "mark" });
  }
  return t.sort((a, b) => a.at - b.at);
};

function computeRecord(area, allEvents, sessions, { today, tz, mark = {}, protects = [], nowMs }) {
  const areaEvents = allEvents.filter((e) => e.area === area && e.day <= today);
  const mentions = areaEvents.filter((e) => e.type === "mention");
  if (!mentions.length) return null;
  const clears = clearTimes(areaEvents, mark).map((c) => ({ ...c, day: c.day || dayKey(new Date(c.at), tz) }));
  const loadsAll = painLoads(mentions, sessions);

  // clean sessions strictly after `fromDay`, up to `toDay` inclusive, with no mention that day
  const mentionDays = new Set(mentions.map((m) => m.day));
  const cleanBetween = (fromDay, toDay, loads) => sessions.filter((s) => s.day > fromDay && s.day <= toDay && !mentionDays.has(s.day) && sessionTrainsArea(s, area, loads, sessions)).length;

  // episodes: split on a 28-day gap, on a clear (mark or "feels fine" report), or
  // when the area had already read cleared by evidence (6 clean sessions)
  const episodes = [];
  let cur = null;
  for (const m of mentions) {
    if (cur) {
      const last = cur.mentions[cur.mentions.length - 1];
      const gap = daysBetween(last.day, m.day);
      const clearedBetween = clears.some((c) => c.at > last.at && c.at <= m.at);
      const loads = loadsAll.filter((l) => l.day <= last.day);
      const evidenceClear = cleanBetween(last.day, addDays(m.day, -1), loads) >= CLEARED_CLEAN;
      if (gap >= EPISODE_GAP_DAYS || clearedBetween || evidenceClear) {
        cur.closedBy = gap >= EPISODE_GAP_DAYS ? "gap" : clearedBetween ? "cleared" : "evidence";
        episodes.push(cur); cur = null;
        m._gapBefore = gap; m._reopenedBy = clearedBetween ? "cleared" : evidenceClear ? "evidence" : "gap";
      }
    }
    if (!cur) cur = { mentions: [], gapBefore: m._gapBefore ?? null, reopenedBy: m._reopenedBy || null };
    cur.mentions.push(m);
  }
  episodes.push(cur);
  const ep = cur;
  const ms = ep.mentions;
  const first = ms[0], last = ms[ms.length - 1];
  const daysSince = daysBetween(last.day, today);
  const loads = loadsAll.filter((l) => l.day >= first.day);
  const cleanSince = cleanBetween(last.day, today, loads);
  const mentions14d = ms.filter((m) => daysBetween(m.day, today) < WINDOW_DAYS).length;
  const mentionsPrev14 = ms.filter((m) => { const d = daysBetween(m.day, today); return d >= WINDOW_DAYS && d < 2 * WINDOW_DAYS; }).length;
  const sevs = ms.map((m) => m.severity);
  const lastSeverity = last.severity;
  const peakSeverity = Math.max(...sevs);
  const clearedAfter = clears.find((c) => c.at > last.at);
  const side = [...ms].reverse().find((m) => m.side)?.side || null;

  // serious: a severity-4 report within 14 days that has not been cleared since
  const serious = ms.filter((m) => m.severity >= SEV_SERIOUS && daysBetween(m.day, today) < WINDOW_DAYS).pop();
  const seriousOpen = serious && !clears.some((c) => c.at > serious.at);

  let state;
  if (seriousOpen) state = "serious";
  else if (clearedAfter || daysSince >= CLEARED_DAYS || cleanSince >= CLEARED_CLEAN) state = "cleared";
  else if ((daysSince >= QUIET_DAYS && cleanSince >= QUIET_CLEAN) || daysSince >= QUIET_ANY_DAYS) state = "quiet";
  else if (cleanSince >= 1 && (daysSince >= EASING_QUIET_DAYS || (sevs.length > 1 && lastSeverity < sevs[sevs.length - 2]))) state = "easing";
  else if (ms.length === 1) state = "new";
  else if (mentions14d >= 2 || (lastSeverity >= SEV_CHANGED && daysSince < ACTIVE_SEV3_DAYS)) state = "active";
  else state = "active";

  // trend: severity across the episode, then frequency
  let trend;
  if (state === "cleared" || state === "quiet") trend = "improving";
  else if (state === "serious" && lastSeverity >= SEV_SERIOUS) trend = "worsening";
  else if (daysSince >= EASING_QUIET_DAYS && cleanSince >= 1) trend = "improving";
  else if (sevs.length < 2) trend = "steady";
  else {
    const prior = sevs.slice(-4, -1);
    const priorMean = prior.reduce((a, b) => a + b, 0) / prior.length;
    const delta = lastSeverity - priorMean;
    if (cleanSince === 0 && (delta >= 1 || (delta >= 0 && mentions14d >= 3 && mentions14d > mentionsPrev14))) trend = "worsening";
    else if (delta <= -1) trend = "improving";
    else trend = "steady";
  }

  const addressedByProgram = (protects || []).includes(area);
  const dismissedAt = mark.dismissed_at ? Date.parse(mark.dismissed_at) : NaN;
  const dismissed = Number.isFinite(dismissedAt) && dismissedAt >= first.at - DAY_MS;
  const offeredAt = mark.offered_at ? Date.parse(mark.offered_at) : NaN;
  const offeredRecently = Number.isFinite(offeredAt) && (nowMs - offeredAt) < OFFER_COOLDOWN_DAYS * DAY_MS;
  const notedAt = mark.noted_at ? Date.parse(mark.noted_at) : NaN;
  const handled = Number.isFinite(notedAt) && notedAt >= last.at;

  let policy = "none";
  if (state === "serious") policy = "address_now";
  else if (state === "new") policy = "acknowledge_once";
  else if (trend === "worsening" && !offeredRecently && !addressedByProgram && !dismissed && state !== "cleared" && state !== "quiet") policy = "offer_change_once";
  const speak = handled ? "none" : policy;

  const declines = +mark.declined_change_count || 0;
  const checkIn = (state === "cleared" || (dismissed && state !== "serious"))
    ? { ask: false, tone: null, askChange: false }
    : {
        ask: true,
        tone: state === "serious" ? "serious" : (state === "easing" || state === "quiet") ? "cleared_yet" : "status",
        askChange: !addressedByProgram && declines < DECLINES_TO_STOP_ASKING && (state === "active" || state === "serious" || state === "new") && trend !== "improving",
      };

  const rec = {
    area, side, label: areaLabel(area), state, trend, lastSeverity, peakSeverity,
    firstAt: first.day, lastAt: last.day, daysSince, mentions: ms.length, mentions14d,
    cleanSessionsSince: cleanSince, addressedByProgram, dismissed,
    offeredAt: Number.isFinite(offeredAt) ? new Date(offeredAt).toISOString() : null,
    gapBefore: ep.gapBefore, reopenedBy: ep.reopenedBy,
    lastDuring: last.during || null, stoppedSession: !!last.stoppedSession,
    speak, policy, fresh: last.day === today, checkIn,
  };
  rec.summary = summarize(rec);
  return rec;
}

// ── the one plain line for Joe, built from numbers (no model call) ──────────
export function summarize(r) {
  const L = r.label.charAt(0).toUpperCase() + r.label.slice(1);
  const bits = [];
  if (r.reopenedBy === "cleared") bits.push(`back ${fmtDay(r.firstAt)} after it had cleared`);
  else if (r.gapBefore != null && r.gapBefore >= EPISODE_GAP_DAYS) bits.push(`back ${fmtDay(r.firstAt)} after ${Math.round(r.gapBefore / 7)} weeks quiet`);
  else if (r.mentions === 1) bits.push(`first mentioned ${fmtDay(r.firstAt)}`);
  else bits.push(`came on ${fmtDay(r.firstAt)}`);
  if (r.mentions > 1) bits.push(`${r.mentions} mentions in this stretch, ${r.mentions14d} in the last 14 days`);
  const latestWord = SEVERITY_WORDS[r.lastSeverity] || "noted";
  bits.push(r.mentions > 1 ? `latest ${fmtDay(r.lastAt)} was ${latestWord}` : `${latestWord}`);
  if (r.daysSince > 0) {
    bits.push(r.cleanSessionsSince > 0
      ? `no mention in ${r.daysSince} day${r.daysSince === 1 ? "" : "s"}, ${r.cleanSessionsSince} clean session${r.cleanSessionsSince === 1 ? "" : "s"} on it since`
      : `no mention in ${r.daysSince} day${r.daysSince === 1 ? "" : "s"}`);
  }
  const dir = r.state === "cleared" ? "cleared"
    : r.state === "serious" ? "serious, needs attention"
    : r.trend === "improving" ? "headed the right way"
    : r.trend === "worsening" ? "getting worse"
    : "holding steady";
  let s = r.state === "cleared" ? `${L}: ${bits.join("; ")}. Reads cleared.` : `${L}: ${bits.join("; ")}. Reads ${r.state}, ${dir}.`;
  if (r.addressedByProgram) s += " The current program already works around it.";
  return s;
}

// ── public API ──────────────────────────────────────────────────────────────
// painStatus({rows, marks, legacyResolved, protects, now, tz, checkIns})
//   rows: workouts rows (real logs + chat rows)
//   marks: athletes.pain_marks {areaKey: {cleared_at, dismissed_at, offered_at, asked_at, noted_at, declined_change_count}}
//   legacyResolved: athletes.resolved_pain (array of strings, no timestamps)
//   protects: area keys the current program protects (programPurpose().protects)
// Returns one record per area with an open or recently closed episode.
export function painStatus({ rows = [], marks = {}, legacyResolved = [], protects = [], now = new Date(), tz, checkIns = [] } = {}) {
  const today = dayKey(now, tz);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const events = extractEvents(rows, { tz, checkIns });
  const sessions = extractSessions(rows, { tz }).filter((s) => s.day <= today);
  const m = normalizeMarks(marks, legacyResolved, { now, tz });
  const areas = [...new Set(events.filter((e) => e.type === "mention").map((e) => e.area))];
  const out = [];
  for (const area of areas) {
    const r = computeRecord(area, events, sessions, { today, tz, mark: m[area] || {}, protects, nowMs });
    if (!r) continue;
    if (r.state === "cleared" && r.daysSince > RECORD_HORIZON_DAYS) continue;
    r.nextMention = nextMentionFor(area, events, sessions, { today, tz, mark: m[area] || {}, protects, nowMs, now });
    out.push(r);
  }
  const rank = { serious: 0, new: 1, active: 2, easing: 3, quiet: 4, cleared: 5 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || (a.lastAt < b.lastAt ? 1 : -1));
}

// What a NEW mention today would become (chat streams before the parser lands).
export const NEXT_MENTION_DEFAULT = Object.freeze({ same: "acknowledge_once", milder: "acknowledge_once", serious: "address_now" });
function nextMentionFor(area, events, sessions, ctx) {
  const prior = events.filter((e) => e.area === area && e.type === "mention" && e.day <= ctx.today);
  const lastSev = prior.length ? prior[prior.length - 1].severity : SEV_DULL;
  const mk = (sev) => {
    const hyp = { type: "mention", day: ctx.today, at: ctx.nowMs + 1, area, side: null, label: areaLabel(area), severity: sev, during: null, source: "chat" };
    const mark = { ...ctx.mark }; delete mark.noted_at;
    const r = computeRecord(area, [...events, hyp], sessions, { ...ctx, mark });
    return r ? r.speak : "acknowledge_once";
  };
  return { same: mk(Math.min(SEV_CHANGED, Math.max(SEV_DULL, lastSev))), milder: mk(Math.max(SEV_AWARE, Math.min(lastSev, SEV_CHANGED) - 1)), serious: "address_now" };
}

// Legacy resolved_pain strings carry no timestamp: treat each as cleared at the
// start of today, so any event dated after the mark reopens the area. A real
// pain_marks.cleared_at always wins.
export function normalizeMarks(marks = {}, legacyResolved = [], { now = new Date(), tz } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(marks || {})) {
    const key = normArea(k).key || k;
    out[key] = { ...(out[key] || {}), ...(v || {}) };
  }
  const today = dayKey(now, tz);
  for (const s of Array.isArray(legacyResolved) ? legacyResolved : []) {
    const key = normArea(s).key;
    if (!key || (out[key] && out[key].cleared_at)) continue;
    out[key] = { ...(out[key] || {}), cleared_at: new Date(keyMs(today) - 1).toISOString(), legacy: true };
  }
  return out;
}

// Pure mark writer: returns a NEW marks object. field: cleared_at | dismissed_at |
// offered_at | asked_at | noted_at, or "declined_change" to bump the counter.
export function withMark(marks, area, field, now = new Date()) {
  const key = normArea(area).key || String(area || "");
  const next = { ...(marks || {}) };
  const cur = { ...(next[key] || {}) };
  if (field === "declined_change") cur.declined_change_count = (+cur.declined_change_count || 0) + 1;
  else cur[field] = (now instanceof Date ? now : new Date(now)).toISOString();
  next[key] = cur;
  return next;
}

// Is this area resolved for display (MY LOG, coach badges, proof)? Ledger
// semantics: a clear hides the area only until the next pain event after it.
export function isAreaCleared(area, record) {
  return !record || record.state === "cleared";
}

// ── the turn's PAIN LEDGER block (chat context) ─────────────────────────────
// One line per open area with its verdict and what a new mention today becomes.
export function ledgerBlock(records, { protects = [], turn = null } = {}) {
  const open = (records || []).filter((r) => r.state !== "cleared");
  const lines = [];
  for (const r of open) {
    const now = r.fresh && r.speak !== "none" ? ` Already mentioned today: ${r.speak}.` : "";
    const nm = r.nextMention || NEXT_MENTION_DEFAULT;
    lines.push(`- ${r.summary}${now} If this message mentions it: ${nm.same} when it sounds as bad or worse than last time, ${nm.milder} when milder, address_now for serious language.`);
  }
  const prot = (protects || []).filter(Boolean).map(areaLabel);
  const head = "PAIN LEDGER (computed by the app from every logged mention, final; you never count mentions, name dates, or describe a pattern beyond what these lines say):";
  const tail = [
    lines.length ? lines.join("\n") : "- No open pain areas.",
    `- Any other area: first mention = acknowledge_once. Serious language (sharp, pop, gave out, numbness, can't bear weight) = address_now.`,
    prot.length ? `- The current program already protects: ${prot.join(", ")}. Never propose changing the program for pain there.` : null,
    turn && turn.serious ? `- THIS MESSAGE reads as serious (${turn.areas.map(areaLabel).join(", ") || "unnamed area"}). Address it now in one or two plain lines. The app will stage a protective program rec after your reply; say that one is coming, never that the program already changed.` : null,
    "Verdicts: none = say nothing about it. acknowledge_once = one calm line inside your reply, then move on. offer_change_once = one line offering to adjust the program if they want; you do not draft it unless they say yes. address_now = speak to it directly. The app posts no pain bubbles of its own.",
  ].filter(Boolean);
  return `${head}\n${tail.join("\n")}`;
}

// Pre-turn read of the raw message: which areas it names, and whether it reads
// serious. Computed once per turn so Joe's context and the post-parse action agree.
export function preTurnPain(message) {
  const text = String(message || "");
  const areas = areasInText(text);
  const t = clean(text);
  const serious = areas.length > 0 && isSeriousText(text) && PAIN_WORDS.test(t);
  return { areas, serious: !!serious };
}
