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
export const NEW_DAYS = 7;              // a first mention reads "new" for a week; after that it is open until evidence says more
export const OPEN_DAYS = 7;             // a week with no mention and no clean session on it: still open, unverified
export const PEAK_FADE_DAYS = 7;        // a degree under the episode's peak, a week or more after it, reads as improving
export const LEGACY_WINDOW_DAYS = 14;   // legacy resolved_pain has no date: mentions inside the last 14 days stay visible (tracked silently)

// Severity scale, defined once.
export const SEV_AWARE = 1;    // tight, slight, "a very small amount"
export const SEV_DULL = 2;     // dull, lingering, flaring, "feeling it"
export const SEV_CHANGED = 3;  // changed or cut the session: "on fire", "stopped early", "had to drop the weight"
export const SEV_SERIOUS = 4;  // sharp, sudden, pop, gave out, numbness, could not bear weight
export const SEVERITY_WORDS = { 1: "mild", 2: "dull or lingering", 3: "bad enough to change the session", 4: "serious" };

// open = mentioned more than a week ago, nothing since, no clean session on it yet
export const STATES = ["serious", "new", "active", "open", "easing", "quiet", "cleared"];
// states that count as CURRENT pain (log-sheet focus notes, profile context)
export const CURRENT_STATES = ["serious", "new", "active", "open"];
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
  ["elbow", /\b(elbows?|tennis elbow|golfer'?s elbow|tricep(s)? tendon|bicep(s)? tendon|distal bicep|olecranon)\b/],
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

// Side from area text: left/right, lt/rt, a bare L or R ("L knee", "knee (L)";
// clean() has already dropped the parentheses), both/bilateral, or a plural.
const sideOf = (t) => {
  const left = /\bleft\b|\blt\b|(?:^|\s)l(?=\s|$)/.test(t), right = /\bright\b|\brt\b|(?:^|\s)r(?=\s|$)/.test(t);
  if (left && right) return "both";
  if (/\b(both|bilateral)\b/.test(t)) return "both";
  if (left) return "left";
  if (right) return "right";
  if (/\b(knees|shoulders|elbows|wrists|ankles|hips|calves|shins|feet|hamstrings|quads)\b/.test(t)) return "both";
  return null;
};
const SIDE_WORDS = /\b(my|the|a|an|left|right|both|lt|rt|bilateral)\b|(?:^|\s)[lr](?=\s|$)/g;

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
  const fallback = t.replace(SIDE_WORDS, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return { key: fallback, side: sideOf(t), label: fallback };
}
export const areaLabel = (key) => AREA_LABELS[key] || String(key || "");

// Every known area named in a free text ("knees flared, and my pec too" -> knee, pec).
// Lift names that contain body words ("back squat", "chest-supported row") are
// not areas; strip them before scanning free text.
const LIFT_PHRASES = /\b(back[- ]off( sets?)?|back to|back and forth|(come|coming|came|get|getting|go|going|went|bring|bringing|ease|easing|build|building|dial|dialing|dialled) (it |them |things )?back|back (in|into|on|down|up|at it)|toes? to bar|back squats?|back extensions?|back raises?|hip thrusts?|hip mobility|hip (ab|ad)ductors?|knee extensions?|terminal knee|calf raises?|shoulder press(es)?|leg press(es)?|chest[- ]?supported|chest press|neck bridges?|behind the neck|wrist curls?|knees? to (elbow|chest)|hanging knee raises?)\b/g;
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
const SEV1_RE = /\b(very small|small amount|a (little|bit|touch)|slight(ly)?|tight|tightness|stiff|stiffness|minor|barely|niggle|twinge|a hint|mild(ly)?)\b/;
// Soreness vs pain (S2b, 09-28). Training soreness belongs to MUSCLE groups
// ("legs too sore", "quads sore from yesterday", DOMS, "in a good way"). A sore
// JOINT or TENDON is pain, and so is any area with an incident word.
const JOINT_AREAS = new Set(["knee", "ankle", "wrist", "elbow", "shoulder", "achilles", "hip"]);
const INCIDENT_RE = /\b((?<!foam )rolled|rolling (it|my|the|an?)\b|twist(ed|ing)|jamm(ed|ing)|pulled (a|my|it|something)\b|a pull in|strain(ed)?|sprain(ed)?|tweak\w*|landed (wrong|bad|badly|funny|awkward\w*)|hyperextend\w*)/;
// a training-load cause turns "sore shoulders" into delts, not the joint
const TRAINING_CAUSE_RE = /\b(doms|from (yesterday|last night|the (workout|session|lift|training|gym)|\w+ day)|in a good way|good sore|good kind of sore|pump)\b/;
// The athlete's own read of the direction. Negated hardeners ("no worse") are not hardeners.
const SOFTENER_RE = /\b(not (too |that |as |so )?bad|not as (bad|much)|less than|way less|much less|a lot less|better|barely|improving|easing|settling|fading|calmer|getting there)\b/;
const HARDENER_RE = /\b((?<!no |not |isn'?t |wasn'?t )worse|worst|more than last time|more than before|getting bad|increasing)\b/;
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
  const painy = PAIN_WORDS.test(all) || INCIDENT_RE.test(all);
  const areaText = clean(area);
  const joint = JOINT_AREAS.has(areaKey) && !(areaKey === "shoulder" && (/\b(delts?|deltoids?)\b/.test(areaText) || TRAINING_CAUSE_RE.test(all)));
  const soreness = !painy && !joint && SORENESS_WORDS.test(all);
  const direction = HARDENER_RE.test(all) ? 1 : SOFTENER_RE.test(all) ? -1 : 0;
  let severity = SEV_DULL;
  if (SEV4_RE.test(all)) severity = SEV_SERIOUS;
  else if (SEV3_RE.test(all)) severity = SEV_CHANGED;
  else if (SEV1_RE.test(all)) severity = SEV_AWARE;
  else if (PRECAUTION_RE.test(all)) severity = SEV_DULL;
  const character = /\bsharp|shooting|stabbing\b/.test(all) ? "sharp"
    : /\bon fire|burn/.test(all) ? "burning"
    : /\btight/.test(all) ? "tight"
    : /\bflar/.test(all) ? "flaring"
    : /\blinger|\bnagg|\bstill (there|hurt|feel|sore|bother|talk)/.test(all) ? "lingering"
    : /\bdull|ache|aching|achy/.test(all) ? "dull"
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
    direction, // -1 the athlete says it is better, +1 worse, 0 neither
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
    // "feels fine now" rides its own parser field so no pain reader mistakes it
    // for a pain flag (the coach push fires on any pain_flags entry)
    const cleared = Array.isArray(pd.pain_cleared) ? pd.pain_cleared : [];
    if (!flags.length && !cleared.length) continue;
    const day = rowDay(w, tz);
    if (!day) continue;
    const at = Date.parse(w.created_at) || keyMs(day);
    for (const c of cleared) {
      const a = normArea(c && (c.area || c));
      if (a.key) events.push({ type: "cleared", day, at, area: a.key, side: a.side, source: "log", rowId: w.id });
    }
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
        direction: [-1, 0, 1].includes(+f.direction) && f.direction != null ? +f.direction : c.direction,
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
      events.push({ type: "mention", day, at, area: a.key, side: a.side, label: a.label, severity: ci.status === "sharp" ? SEV_CHANGED : SEV_DULL, character: ci.status === "sharp" ? "sharp" : "lingering", onset: "gradual", stoppedSession: false, during: null, direction: 0, description: `check-in: ${ci.status}`, source: "checkin" });
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
    let hit = null, hitDay = null;
    for (const s of cands) {
      hit = s.lifts.find((l) => l.id === dId) || s.lifts.find((l) => dNorm && l.norm.includes(dNorm));
      if (hit) { hitDay = s.day; break; }
    }
    if (hit) out.push({ id: hit.id, norm: hit.norm, kg: hit.kg, bodyweight: hit.bodyweight || !(hit.kg > 0), day: e.day, sessionDay: hitDay });
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

// ── trend: which way the episode is headed ──────────────────────────────────
// Degree first, weighed against the episode's PEAK and how long ago it was;
// then the athlete's own words ("not bad", "worse"); then load on the lift that
// hurt going up; frequency only when degree is not falling. S2b (09-28): the
// founder's "sharp 3 weeks ago, lingering since, dull today" read steady because
// frequency held it there.
export function trendFor({ ms, state, cleanSince = 0, daysSince = 0, mentions14d = 0, mentionsPrev14 = 0, loadRising = false }) {
  const last = ms[ms.length - 1];
  const lastSev = last.severity;
  if (state === "cleared" || state === "quiet") return "improving";
  if (state === "serious" && lastSev >= SEV_SERIOUS) return "worsening";
  if (last.direction > 0) return "worsening";                        // they said it is worse
  if (daysSince >= EASING_QUIET_DAYS && cleanSince >= 1) return "improving";
  if (ms.length < 2) return "steady";                                 // one point is not a direction
  const prev = ms[ms.length - 2];
  const earlier = ms.slice(0, -1);
  const peakSev = Math.max(...earlier.map((m) => m.severity));
  const peakDay = [...earlier].reverse().find((m) => m.severity === peakSev).day;
  const prior = ms.slice(-4, -1);
  const delta = lastSev - prior.reduce((a, m) => a + m.severity, 0) / prior.length;
  if (last.direction < 0) return lastSev > prev.severity ? "steady" : "improving"; // "not bad", "better"
  if (cleanSince === 0 && delta >= 1) return "worsening";            // degree climbing
  if (lastSev < peakSev && daysBetween(peakDay, last.day) >= PEAK_FADE_DAYS && lastSev <= prev.severity) return "improving"; // off the peak and staying off it
  if (loadRising && lastSev <= prev.severity) return "improving";     // lifting more on what hurt, no worse for it
  if (delta <= -1) return "improving";
  if (cleanSince === 0 && delta >= 0 && mentions14d >= 3 && mentions14d > mentionsPrev14) return "worsening"; // coming up more often, no milder
  return "steady";
}

// Plain word for one mention's degree, for the trajectory line.
export function degreeWord(m) {
  const s = m.severity, c = m.character;
  if (s >= SEV_SERIOUS) return c === "sharp" ? "sharp" : "serious";
  if (s === SEV_CHANGED) return "bad enough to change the session";
  if (s === SEV_DULL) return c === "lingering" || c === "flaring" ? c : "dull";
  return c === "tight" ? "tight" : "mild";
}

// Relative time from a day key to today, in plain words.
export function relDay(day, today) {
  const d = daysBetween(day, today);
  if (d <= 0) return "today";
  if (d === 1) return `yesterday (${fmtDay(day)})`;
  if (d < 14) return `${d} days ago (${fmtDay(day)})`;
  if (d < 63) return `${Math.round(d / 7)} weeks ago (${fmtDay(day)})`;
  return `${Math.round(d / 30)} months ago (${fmtDay(day)})`;
}

// ── the record for one area ──────────────────────────────────────────────────
const clearTimes = (areaEvents, mark) => {
  const t = areaEvents.filter((e) => e.type === "cleared").map((e) => ({ day: e.day, at: e.at, source: e.source }));
  if (mark && mark.cleared_at) {
    const at = Date.parse(mark.cleared_at);
    if (Number.isFinite(at)) t.push({ day: mark.cleared_day || null, at, source: mark.legacy ? "legacy" : "mark" });
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
      const clr = clears.find((c) => c.at > last.at && c.at <= m.at);
      const clearedBetween = !!clr;
      const loads = loadsAll.filter((l) => l.day <= last.day);
      const evidenceClear = cleanBetween(last.day, addDays(m.day, -1), loads) >= CLEARED_CLEAN;
      if (gap >= EPISODE_GAP_DAYS || clearedBetween || evidenceClear) {
        cur.closedBy = gap >= EPISODE_GAP_DAYS ? "gap" : clearedBetween ? "cleared" : "evidence";
        episodes.push(cur); cur = null;
        m._gapBefore = gap; m._reopenedBy = clearedBetween ? (clr.source === "legacy" ? "legacy" : "cleared") : evidenceClear ? "evidence" : "gap";
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
  else if (ms.length === 1 && daysSince < NEW_DAYS) state = "new";
  else if (mentions14d >= 2 || (lastSeverity >= SEV_CHANGED && daysSince < ACTIVE_SEV3_DAYS) || daysSince < OPEN_DAYS) state = "active";
  else state = "open"; // mentioned a while back, nothing since, nothing logged on it that shows it settled

  // rising load on the lift that hurt: the latest mention's load against the
  // last session in this episode that trained the same lift
  let loadRising = false;
  const lastLoad = loadsAll.filter((l) => l.day === last.day && l.kg > 0).pop();
  if (lastLoad && lastLoad.sessionDay) {
    let before = 0;
    for (const s of sessions) {
      if (s.day < first.day || s.day >= lastLoad.sessionDay) continue;
      const x = s.lifts.find((l) => l.id === lastLoad.id && l.kg > 0);
      if (x) before = x.kg;
    }
    loadRising = before > 0 && lastLoad.kg > before + 0.5;
  }
  const trend = trendFor({ ms, state, cleanSince, daysSince, mentions14d, mentionsPrev14, loadRising });

  // legacy resolved_pain carries no date: an episode that starts inside the
  // window after the legacy clear may predate the tap, so it is tracked, not voiced
  const legacyAt = mark.legacy && mark.cleared_at ? Date.parse(mark.cleared_at) : NaN;
  const legacyEpisode = Number.isFinite(legacyAt) && first.at > legacyAt && (first.at - legacyAt) <= (LEGACY_WINDOW_DAYS + 1) * DAY_MS;

  const addressedByProgram = (protects || []).includes(area);
  const dismissedAt = mark.dismissed_at ? Date.parse(mark.dismissed_at) : NaN;
  const dismissed = Number.isFinite(dismissedAt) && dismissedAt >= first.at - DAY_MS;
  const offeredAt = mark.offered_at ? Date.parse(mark.offered_at) : NaN;
  const offeredRecently = Number.isFinite(offeredAt) && (nowMs - offeredAt) < OFFER_COOLDOWN_DAYS * DAY_MS;
  const notedAt = mark.noted_at ? Date.parse(mark.noted_at) : NaN;
  const handled = Number.isFinite(notedAt) && notedAt >= last.at;

  let policy = "none";
  if (state === "serious") policy = "address_now";
  else if (legacyEpisode) policy = "none";
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
    offeredAt: Number.isFinite(offeredAt) ? new Date(offeredAt).toISOString() : null, offeredRecently,
    offeredDay: Number.isFinite(offeredAt) ? dayKey(new Date(offeredAt), tz) : null,
    gapBefore: ep.gapBefore, reopenedBy: ep.reopenedBy,
    lastDuring: last.during || null, stoppedSession: !!last.stoppedSession,
    speak, policy, fresh: last.day === today, checkIn,
    loadRising, legacyEpisode, clearedBy: state === "cleared" ? (clearedAfter ? clearedAfter.source : "evidence") : null,
    // the degree trajectory in time order, for the plain line (no counts)
    trajectory: ms.map((m) => ({ day: m.day, word: degreeWord(m), severity: m.severity })),
    today,
  };
  rec.summary = summarize(rec);
  return rec;
}

// ── the one plain line for Joe, built from numbers (no model call) ──────────
// The founder's shape (09-28): "sharp 3 weeks ago, lingering since, dull today,
// headed the right way". Degree trajectory in time order, relative time, no
// counts (real-AI pass 09-28: Joe turned counts into "twice", "second time");
// the numbers stay on the record.
export function summarize(r) {
  const L = r.label.charAt(0).toUpperCase() + r.label.slice(1);
  const today = r.today || r.lastAt;
  const tr = r.trajectory && r.trajectory.length ? r.trajectory : [{ day: r.firstAt, word: degreeWord({ severity: r.lastSeverity }) }];
  const first = tr[0], last = tr[tr.length - 1];
  const parts = [];
  const back = r.reopenedBy === "cleared" ? "after it had cleared"
    : r.gapBefore != null && r.gapBefore >= EPISODE_GAP_DAYS ? `after ${Math.round(r.gapBefore / 7)} weeks quiet`
    : r.reopenedBy === "legacy" ? "after they marked it resolved"
    : null;
  parts.push(back ? `back ${relDay(first.day, today)} ${back}, ${first.word}` : `${first.word} ${relDay(first.day, today)}`);
  if (tr.length > 1) {
    const mid = tr.slice(1, -1);
    const words = [...new Set(mid.map((m) => m.word))];
    if (words.length) parts.push(words.length === 1 ? `${words[0]} since` : "up and down since");
    const prevWord = tr[tr.length - 2].word;
    const lw = last.word !== prevWord ? last.word : mid.length ? `still ${last.word}` : `${last.word} again`;
    parts.push(`${lw} ${relDay(last.day, today)}`);
  }
  if (r.cleanSessionsSince > 0) parts.push(r.cleanSessionsSince >= QUIET_CLEAN ? "trained it without pain several times since" : "trained it without pain since");
  const dir = r.state === "serious" ? (r.trend === "improving" ? "Serious, needs attention, though headed the right way since." : "Serious, needs attention.")
    : r.state === "cleared" ? (r.clearedBy === "log" || r.clearedBy === "checkin" ? "Cleared, they said it feels fine." : r.clearedBy === "mark" || r.clearedBy === "legacy" ? "Cleared, they marked it resolved." : "Cleared.")
    : r.state === "quiet" ? "Gone quiet, headed the right way."
    : r.state === "easing" ? "Easing, headed the right way."
    : r.state === "open" ? "Still open: no mention since, and no session on it yet that shows it has settled."
    : r.state === "new" ? "Just noted."
    : r.trend === "improving" ? "Headed the right way."
    : r.trend === "worsening" ? "Getting worse."
    : "Holding steady.";
  let s = `${L}: ${parts.join(", ")}. ${dir}`;
  if (r.legacyEpisode && r.state !== "cleared") s += " They had marked this area resolved at some point before.";
  if (r.addressedByProgram) s += " The current program already works around it.";
  if (r.offeredRecently && r.state !== "cleared") s += ` A program change was already offered ${fmtDay(r.offeredDay)}; it stays their call, do not offer or stage one again.`;
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
  const rank = Object.fromEntries(STATES.map((s, i) => [s, i]));
  return out.sort((a, b) => rank[a.state] - rank[b.state] || (a.lastAt < b.lastAt ? 1 : -1));
}

// What a NEW mention today would become (chat streams before the parser lands).
// worse = they say it is worse; same = about as bad as last time; milder = less.
export const NEXT_MENTION_DEFAULT = Object.freeze({ worse: "acknowledge_once", same: "acknowledge_once", milder: "acknowledge_once", serious: "address_now" });
function nextMentionFor(area, events, sessions, ctx) {
  const prior = events.filter((e) => e.area === area && e.type === "mention" && e.day <= ctx.today);
  const lastSev = prior.length ? prior[prior.length - 1].severity : SEV_DULL;
  const mk = (sev, direction = 0) => {
    const hyp = { type: "mention", day: ctx.today, at: ctx.nowMs + 1, area, side: null, label: areaLabel(area), severity: sev, during: null, direction, source: "chat" };
    const mark = { ...ctx.mark }; delete mark.noted_at;
    const r = computeRecord(area, [...events, hyp], sessions, { ...ctx, mark });
    return r ? r.speak : "acknowledge_once";
  };
  const same = Math.min(SEV_CHANGED, Math.max(SEV_DULL, lastSev));
  return { worse: mk(same, 1), same: mk(same), milder: mk(Math.max(SEV_AWARE, Math.min(lastSev, SEV_CHANGED) - 1), -1), serious: "address_now" };
}

// Legacy resolved_pain strings carry no timestamp. S2b (09-28): treat each as
// cleared just before the last LEGACY_WINDOW_DAYS, so older mentions stay
// cleared and a mention inside the window stays visible (computeRecord tracks
// it silently unless serious). A real pain_marks.cleared_at always wins.
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
    out[key] = { ...(out[key] || {}), cleared_at: new Date(keyMs(addDays(today, -(LEGACY_WINDOW_DAYS - 1))) - 1).toISOString(), legacy: true };
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
  if (field === "cleared_at") delete cur.legacy; // a real, dated resolve replaces the undated one
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
  // Areas THIS message mentions show the picture including this message (right
  // counts), with the turn's verdict; every other open area shows history and
  // what a mention would become.
  const turnAreas = new Set(turn && turn.exact ? turn.areas || [] : []);
  const withTurn = (turn && turn.recordsWithTurn) || [];
  const open = (records || []).filter((r) => r.state !== "cleared" && !turnAreas.has(r.area));
  const lines = [];
  for (const a of turnAreas) {
    const r = withTurn.find((x) => x.area === a);
    if (r) lines.push(`- ${r.summary} (This message included.) Verdict for this message: ${turn.verdicts[a]}.`);
  }
  for (const r of open) {
    const now = r.fresh && r.speak !== "none" && !(turn && turn.verdicts && turn.verdicts[r.area]) ? ` Already mentioned today: ${r.speak}.` : "";
    const nm = { ...NEXT_MENTION_DEFAULT, ...(r.nextMention || {}) };
    lines.push(`- ${r.summary}${now} If this message mentions it: ${nm.worse} when they say it is worse, ${nm.same} when it sounds about as bad as last time, ${nm.milder} when milder, address_now for serious language.`);
  }
  // cleared areas stay on the record so "how's my knee?" and "back after it had
  // cleared" have a true answer; they carry no verdict of their own
  for (const r of (records || []).filter((x) => x.state === "cleared" && !turnAreas.has(x.area))) {
    lines.push(`- ${r.summary} Say nothing about it unless they ask.`);
  }
  const prot = (protects || []).filter(Boolean).map(areaLabel);
  const head = "PAIN LEDGER (computed by the app from every logged mention, final; you never count mentions, name dates, or describe a pattern beyond what these lines say):";
  const tail = [
    lines.length ? lines.join("\n") : "- No open pain areas.",
    `- Any other area: first mention = acknowledge_once. Serious language (sharp, pop, gave out, numbness, can't bear weight) = address_now.`,
    prot.length ? `- The current program already protects: ${prot.join(", ")}. Never propose changing the program for pain there.` : null,
    turn && turn.areas && turn.areas.length ? turnLine(turn) : null,
    turn && turn.serious ? `- THIS MESSAGE reads as serious (${turn.areas.map(areaLabel).join(", ") || "unnamed area"}). Address it now in one or two plain lines. The app will stage a protective program rec after your reply; say that one is coming, never that the program already changed.` : null,
    "Verdicts: none = say nothing about it beyond what the session needs, no program talk about that area, even if it sounds worse. acknowledge_once = one calm line inside your reply, then move on. offer_change_once = one line offering to adjust the program if they want; you do not draft it unless they say yes. address_now = speak to it directly. Call propose_program_rec for pain ONLY when a line here says address_now or the athlete asks for a change in this message; the app drops any other pain rec. Never say first, second or third time. The app posts no pain bubbles of its own.",
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
  // the athlete's own read ("worse", "not as bad") picks the nextMention branch
  const direction = HARDENER_RE.test(t) ? 1 : SOFTENER_RE.test(t) ? -1 : 0;
  return { areas, serious: !!serious, direction };
}

// ── one call per chat turn ───────────────────────────────────────────────────
// Joe's context (before the reply) and the post-parse code (after it) both call
// this with the same inputs, so they reach the same verdict (AI contract rule 4).
// When the parse is already in hand (log-shaped messages hold the reply behind
// the parse) the message's own pain flags ride in as a synthetic row and the
// verdict per area is exact; otherwise the areas named in the text get their
// nextMention verdict, and serious language is address_now.
export function ledgerTurn({ rows = [], marks = {}, legacyResolved = [], protects = [], now = new Date(), tz, message = "", parsed = null, checkIns = [] } = {}) {
  const pre = preTurnPain(message);
  const flags = (parsed && Array.isArray(parsed.pain_flags)) ? parsed.pain_flags.filter((f) => f && f.area) : [];
  const base = painStatus({ rows, marks, legacyResolved, protects, now, tz, checkIns });
  const verdicts = {};
  let records = base;
  let serious = pre.serious;
  if (parsed) {
    const synthetic = { id: "__turn__", created_at: (now instanceof Date ? now : new Date(now)).toISOString(), raw_message: message, parsed_data: { ...parsed, log_date: null } };
    const withTurn = painStatus({ rows: [synthetic, ...rows], marks, legacyResolved, protects, now, tz, checkIns });
    const turnEvents = extractEvents([synthetic], { tz }).filter((e) => e.type === "mention");
    for (const e of turnEvents) {
      const r = withTurn.find((x) => x.area === e.area);
      if (r) verdicts[e.area] = r.speak;
      if (e.severity >= SEV_SERIOUS) serious = true;
    }
    // the block's per-area lines describe history BEFORE this message (the
    // turn line carries this message's verdict); post-parse readers that need
    // the updated picture (the rec drafter) use recordsWithTurn
    const t = finishTurn(verdicts, serious, true);
    Object.defineProperty(t, "recordsWithTurn", { value: withTurn, enumerable: false });
    return { records: base, recordsWithTurn: withTurn, turn: t };
  } else {
    for (const a of pre.areas) {
      const r = base.find((x) => x.area === a);
      const nm = { ...NEXT_MENTION_DEFAULT, ...(r ? r.nextMention : {}) };
      verdicts[a] = pre.serious ? "address_now" : pre.direction > 0 ? nm.worse : pre.direction < 0 ? nm.milder : nm.same;
    }
  }
  return { records, recordsWithTurn: records, turn: finishTurn(verdicts, serious, false) };
}
function finishTurn(verdicts, serious, exact) {
  if (serious) for (const a of Object.keys(verdicts)) verdicts[a] = "address_now";
  const areas = Object.keys(verdicts);
  return { areas, serious: !!serious && areas.length > 0, verdicts, exact };
}

// The line naming THIS message's verdicts, for the block.
export function turnLine(turn) {
  if (!turn || !turn.areas.length) return "";
  const parts = turn.areas.map((a) => `${areaLabel(a)}: ${(turn.verdicts || {})[a] || (turn.serious ? "address_now" : "acknowledge_once")}`);
  return turn.exact
    ? `- THIS MESSAGE mentions pain. Verdict per area (final): ${parts.join("; ")}.`
    : `- THIS MESSAGE may mention pain (${turn.areas.map(areaLabel).join(", ")}). If it is real pain and not training soreness, use: ${parts.join("; ")}.`;
}

// ── after the parse: what code does with this turn's pain (pure plan) ────────
// Joe is the only voice on a first report or a pattern: this plan posts NO pain
// bubble. It stamps the marks (noted_at always, offered_at when the verdict was
// an offer) and drafts a protective rec ONLY on address_now (a serious report).
// The one app line allowed is the truthful confirmation after a rec is staged.
export function painFollowUpPlan(turn, now = new Date()) {
  const stamps = [];
  let draftRec = false;
  for (const a of (turn && turn.areas) || []) {
    const v = turn.verdicts[a];
    stamps.push({ area: a, field: "noted_at" });
    if (v === "offer_change_once") stamps.push({ area: a, field: "offered_at" });
    if (v === "address_now") draftRec = true;
  }
  return { stamps, draftRec: draftRec && !!(turn && turn.serious), bubble: null, at: (now instanceof Date ? now : new Date(now)).toISOString() };
}

export function applyStamps(marks, stamps, now = new Date()) {
  return (stamps || []).reduce((m, s) => withMark(m, s.area, s.field, now), marks || {});
}

// The one truthful line after a protective rec actually staged.
export const recStagedLine = (areas) => `Drafted a program rec for your ${(areas || []).map(areaLabel).join(" and ") || "report"}. It's at the bottom of your screen, open it when you're ready.`;

// Display rule for a single stored pain flag (MY LOG, coach roster, proof):
// hidden only when its area has a clear dated AT OR AFTER the flag's row. A flag
// logged after the clear is a flare and shows again. `marks` should be the
// normalizeMarks() output so legacy resolved_pain strings count too.
export function flagClearedFor(area, rowAt, marks) {
  const m = (marks || {})[normArea(area).key];
  if (!m || !m.cleared_at) return false;
  const t = rowAt instanceof Date ? rowAt.getTime() : Date.parse(rowAt);
  const c = Date.parse(m.cleared_at);
  if (!Number.isFinite(c)) return false;
  return Number.isFinite(t) ? t <= c : true; // an undated row sits before any clear
}

// ── Joe's own propose_program_rec on a pain turn (AI contract rule 4) ───────
// The ledger decided first (before the reply); Joe's tool call decides second
// and must read it. A pain rec from Joe stands only when this turn's verdict is
// address_now for some area, or the athlete asked for a change in words.
// Real-AI pass 09-28: with the verdict "none" (offered yesterday, 14-day quiet)
// Joe staged a rec himself in 4 of 5 runs.
const ASKS_CHANGE_RE = /\b(change|adjust|swap|modify|update|fix|rework|switch|replace|sub)\b[^.!?]{0,40}\b(program|plan|workouts?|squats?|bench|deadlifts?|day|days|session|lifts?|block|week)\b|\b(can|could|would|will) you\b[^.!?]{0,30}\b(change|adjust|swap|drop|replace|work around|take out|pull)\b|\b(work|train|program) around (it|my|the)\b/i;
export const asksForChange = (message) => ASKS_CHANGE_RE.test(String(message || ""));
export function keepPainRec(turn, message) {
  if (!turn || !turn.areas || !turn.areas.length) return true; // not a pain turn: not the ledger's call
  if (turn.areas.some((a) => turn.verdicts[a] === "address_now")) return true;
  return asksForChange(message);
}

// ── CURRENT pain for surfaces outside chat (S2b item 10) ─────────────────────
// The profile's injury_history is undated background from signup. What hurts NOW
// comes from here: only areas whose state is new, open, active or serious.
export function currentPainAreas(records) {
  return (records || []).filter((r) => r && CURRENT_STATES.includes(r.state)).map((r) => r.area);
}
export function currentPainLines(records) {
  return (records || []).filter((r) => r && CURRENT_STATES.includes(r.state)).map((r) => `- ${r.summary}`).join("\n");
}

// Log-sheet focus note guard: a model-written note may name a body part as a
// cue ("knees out"), but a sentence that talks about PAIN in an area that is not
// current pain is dropped. Code decides; a cleared or quiet area never reaches
// the note (the founder's Sep 9 "your pec's still lingering").
const PAIN_TALK = new RegExp(`${PAIN_WORDS.source}|\\b(linger\\w*|sore\\w*|tender|careful|go easy|easy on|protect\\w*|nagg\\w*|recover\\w*|heal\\w*|rehab\\w*|guard\\w*|injur\\w*|flare\\w*|irritat\\w*)\\b`);
export function painNoteGuard(text, allowAreas = []) {
  const allow = new Set(allowAreas || []);
  const src = String(text || "");
  if (!src.trim()) return src;
  const orig = src.split("\n");
  const lines = orig.map((line) => {
    const sents = line.split(/(?<=[.!?])\s+/);
    const kept = sents.filter((s) => {
      const areas = areasInText(s);
      if (!areas.length || !PAIN_TALK.test(clean(s))) return true;
      return areas.every((a) => allow.has(a));
    });
    return kept.length === sents.length ? line : kept.join(" ").trim();
  });
  // drop lines the guard emptied; keep the note's own blank lines
  return lines.filter((l, i) => l.trim() || !orig[i].trim()).join("\n").trim();
}
