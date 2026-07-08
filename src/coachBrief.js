// ─── THE MORNING BRIEF — deterministic beat engine (Coach Dashboard v2, Part C) ──
//
// ZERO-TOKEN DESIGN: every beat below is a templated string filled from data the
// client already computed in CoachOverview's `D` memo (proofcore math — triage,
// adherence, injuries, wins, volume trend). No network call, no AI, no randomness:
// the SAME (D, athletes, changeRequests, cleared, dateKey) always produces the SAME
// brief, so re-renders don't flicker and two coaches loading the same day see the
// same wording. Phrasing variety comes from a pure string hash of `dateKey` (never
// Date.now()/Math.random()), so the brief still reads fresh morning to morning
// without costing a token. AI only enters the picture later, when the coach types a
// free-text reply — that path lives in coach.jsx (Haiku reaction), not here.
//
// This file is intentionally React-free and side-effect-free so it can be unit
// tested with plain `node --input-type=module -e`.

/**
 * @typedef {Object} Action
 * @property {string} id
 * @property {string} label
 * @property {'open_athlete'|'prefill_program'|'resolve_request'|'decision'|'share_wins'|'done'} kind
 * @property {Object} [payload]
 */

/**
 * @typedef {Object} Beat
 * @property {string} id
 * @property {'opening'|'concern'|'trend'|'question'|'wins'|'allclear'} kind
 * @property {string} prose
 * @property {string} [athleteId]
 * @property {string} [athleteName]
 * @property {'injury'|'quiet'|'adherence'|'request'} [flag]
 * @property {Action[]} actions
 * @property {{id:string,text:string,chips:string[]}} [question]
 * @property {Object} [meta] Extra context (area/days/score/…) so decisionNote() can
 *   write a specific note without re-deriving data the UI doesn't otherwise need.
 */

const DAYMS = 86400000;

// ── pure string hash (djb2-ish) — deterministic, no Date.now()/Math.random() ────
function hashStr(s) {
  let h = 5381;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Pick a template variant for a given beat, deterministic per (dateKey, beatIndex).
function pick(templates, dateKey, beatIndex) {
  const arr = Array.isArray(templates) ? templates : [templates];
  if (!arr.length) return "";
  const idx = (hashStr(dateKey) + beatIndex) % arr.length;
  return arr[idx];
}

const plural = (n, s = "s") => (n === 1 ? "" : s);
const clamp = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

// ── injury area → concrete swap suggestion ───────────────────────────────────
function areaSuggestion(area) {
  const a = String(area || "").toLowerCase();
  if (/shoulder|overhead|rotator|delt/.test(a)) return "pull overhead pressing and slot in landmine press until it settles";
  if (/knee/.test(a)) return "pull deep knee flexion and swap in box squat or leg press until it settles";
  if (/back|spine|lumbar|si\b/.test(a)) return "cut axial loading and shift the main lift to trap-bar work until it settles";
  if (/elbow/.test(a)) return "pull heavy elbow flexion/extension work and keep loading light until it settles";
  if (/hip|groin/.test(a)) return "pull deep hip flexion under load and swap in box squat or belt squat until it settles";
  if (/wrist|forearm/.test(a)) return "pull direct wrist loading and switch to neutral-grip or dumbbell variations until it settles";
  return "pull the movement loading it and sub in a pain-free variation until it settles";
}

// ── ISO-8601 week key, Monday start ("2026-W28") ──────────────────────────────
export function briefWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dow + 3); // move to this ISO week's Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDow = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDow + 3);
  const weekNum = 1 + Math.round((date - firstThursday) / (7 * DAYMS));
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

const OPEN_ATHLETE_ACTION = (athleteId) => ({ id: "open", kind: "open_athlete", label: "Open", payload: { athleteId } });

// ── build one concern beat from a triage item (+ optional merged change request) ─
function buildConcernBeat({ t, row, req, dateKey, beatIndex }) {
  const name = t.name;
  const athleteId = t.id;
  const baseFlag = t.kind === "Injury" ? "injury" : t.kind === "Quiet" ? "quiet" : "adherence";

  // Pending change request wins the merge — quote it, flag='request'.
  if (req) {
    const reason = req.reason || (Array.isArray(req.items) && req.items[0] && req.items[0].suggested_change) || "a program change";
    const item = Array.isArray(req.items) ? req.items[0] : null;
    const itemNote = item ? ` (${item.lift}: ${item.suggested_change})` : "";
    // Keep the underlying signal (injury area / quiet days) in meta so the question
    // bank and decisionNote can still cite it even though the request took over.
    const inj = row && row.injuries;
    const area = (inj && (((inj.recurring || [])[0] || {}).area || (inj.active || [])[0])) || null;
    const templates = [
      `${name} asked for a change: "${reason}"${itemNote}.`,
      `There's a pending request from ${name}: "${reason}"${itemNote}.`,
      `${name} flagged this in their program: "${reason}"${itemNote}.`,
    ];
    const prose = pick(templates, dateKey, beatIndex);
    return {
      id: `concern:${athleteId}:${baseFlag}`,
      kind: "concern",
      prose,
      athleteId,
      athleteName: name,
      flag: "request",
      meta: { baseFlag, reason, requestId: req.id, ...(area ? { area } : {}) },
      actions: [
        { id: "apply", kind: "resolve_request", label: "Apply", payload: { requestId: req.id, resolution: "applied" } },
        { id: "edit", kind: "resolve_request", label: "Edit", payload: { requestId: req.id, resolution: "edit" } },
        { id: "skip", kind: "resolve_request", label: "Skip", payload: { requestId: req.id, resolution: "skipped" } },
        OPEN_ATHLETE_ACTION(athleteId),
      ],
    };
  }

  if (baseFlag === "injury") {
    const inj = row && row.injuries;
    const rec = inj && inj.recurring && inj.recurring[0];
    const area = (rec && rec.area) || (inj && inj.active && inj.active[0]) || "the area";
    const count = rec ? rec.count : 1;
    const suggestion = areaSuggestion(area);
    const templates = [
      `${name}'s ${area} has flagged ${count > 1 ? `${count} sessions running` : "this week"}. I'd ${suggestion}.`,
      `${name} keeps flagging ${area} — ${count} session${plural(count)} now. Time to ${suggestion}.`,
      `${area} is still bugging ${name} (${count}x). Worth pulling back: ${suggestion}.`,
    ];
    const prose = pick(templates, dateKey, beatIndex);
    return {
      id: `concern:${athleteId}:injury`,
      kind: "concern",
      prose,
      athleteId,
      athleteName: name,
      flag: "injury",
      meta: { area, count },
      actions: [
        { id: "prefill", kind: "prefill_program", label: "Draft the change", payload: { suggestion: `${area}: ${suggestion}.` } },
        { id: "handled", kind: "decision", label: "I'll handle it", payload: { decision: "handled" } },
        { id: "watching", kind: "decision", label: "Watching it", payload: { decision: "watching" } },
        OPEN_ATHLETE_ACTION(athleteId),
      ],
    };
  }

  if (baseFlag === "quiet") {
    let days = null;
    // D.inactive carries {name, days} — cross-reference by name for a concrete count.
    if (row && row.__inactive) {
      const hit = row.__inactive.find((x) => x.name === name);
      if (hit && hit.days != null) days = hit.days;
    }
    const daysTxt = days != null ? `${days} day${plural(days)}` : "a bit";
    const templates = [
      `${name}'s gone quiet — ${daysTxt}, and they were training the week before. Season over, or worth a conversation?`,
      `${name} hasn't logged in ${daysTxt} after a solid week before that. Worth checking in.`,
      `Nothing from ${name} in ${daysTxt} — they were training regularly before this. Flagging it.`,
    ];
    const prose = pick(templates, dateKey, beatIndex);
    return {
      id: `concern:${athleteId}:quiet`,
      kind: "concern",
      prose,
      athleteId,
      athleteName: name,
      flag: "quiet",
      meta: { days },
      actions: [
        { id: "talk", kind: "decision", label: "I'll talk to them", payload: { decision: "talk" } },
        { id: "season_done", kind: "decision", label: "Season's done", payload: { decision: "season_done" } },
        { id: "dismiss", kind: "decision", label: "Not a concern", payload: { decision: "dismiss" } },
        OPEN_ATHLETE_ACTION(athleteId),
      ],
    };
  }

  // adherence
  const score = row ? row.score : null;
  const thisWkCount = row ? row.thisWk.length : 0;
  const presDays = row ? (row.a.training_days_per_week || (row.adherence && row.adherence.presDays) || null) : null;
  const sessionsCite = presDays ? `${thisWkCount} of ${presDays} prescribed days` : `${thisWkCount} session${plural(thisWkCount)}`;
  const gapLift = row && row.adherence && Array.isArray(row.adherence.byLift) ? row.adherence.byLift[0] : null;
  const liftNote = gapLift && gapLift.volumeGapPct >= 15 ? ` Biggest gap: ${gapLift.lift} (${gapLift.volumeGapPct}% under).` : "";
  const templates = [
    `${name} hit ${sessionsCite} this week (${score}% adherence).${liftNote}`,
    `${name}'s adherence is slipping — ${score}% this week, ${sessionsCite}.${liftNote}`,
    `${score}% adherence for ${name} this week (${sessionsCite}).${liftNote}`,
  ];
  const prose = pick(templates, dateKey, beatIndex);
  return {
    id: `concern:${athleteId}:adherence`,
    kind: "concern",
    prose,
    athleteId,
    athleteName: name,
    flag: "adherence",
    meta: { score, sessionsCite },
    actions: [
      { id: "handled", kind: "decision", label: "I'll handle it", payload: { decision: "handled" } },
      { id: "trim", kind: "prefill_program", label: "Trim their week", payload: { suggestion: `Trim the week down — they hit ${sessionsCite}. Cut a day or drop accessory volume before touching the main lifts.` } },
      { id: "dismiss", kind: "decision", label: "Not a concern", payload: { decision: "dismiss" } },
      OPEN_ATHLETE_ACTION(athleteId),
    ],
  };
}

// ── trend beat — pick ONE signal by priority ──────────────────────────────────
function buildTrendBeat(D, dateKey, beatIndex) {
  const vw = Array.isArray(D.volWeeks) && D.volWeeks.length === 4 ? D.volWeeks : [0, 0, 0, 0];
  const spike = vw[0] > 0 && vw[3] > vw[0] * 1.5;
  const pct = vw[0] > 0 ? Math.round(((vw[3] - vw[0]) / vw[0]) * 100) : null;

  if (spike) {
    const templates = [
      `Team volume's up ${pct}% over four weeks — worth keeping an eye on the load.`,
      `Volume's climbing fast, ${pct}% over the last month. Watch for overreaching.`,
      `Four-week volume trend is up ${pct}% — good sign, just don't let it run away from you.`,
    ];
    return { text: pick(templates, dateKey, beatIndex), tag: "volume climbing" };
  }
  if (D.teamAdh != null && D.teamAdh < 60) {
    const templates = [
      `Team adherence sits at ${D.teamAdh}% right now — worth a look at what's slipping.`,
      `Adherence is soft this week, ${D.teamAdh}% team-wide. Something's getting in the way.`,
      `${D.teamAdh}% team adherence — below where you'd want it.`,
    ];
    return { text: pick(templates, dateKey, beatIndex), tag: "adherence slipping" };
  }
  if (D.prThisWk > 0) {
    const templates = [
      `${D.prThisWk} true PR${plural(D.prThisWk)} landed this week — the roster's trending up.`,
      `${D.prThisWk} real PR${plural(D.prThisWk)} this week. Momentum's there.`,
      `Roster banked ${D.prThisWk} true PR${plural(D.prThisWk)} this week — keep the loading honest.`,
    ];
    return { text: pick(templates, dateKey, beatIndex), tag: "PRs rolling in" };
  }
  const templates = [
    `Team volume's holding steady week to week — nothing alarming either direction.`,
    `Volume trend is flat and healthy. Nothing to react to here.`,
    `Load's staying in a steady band across the roster.`,
  ];
  return { text: pick(templates, dateKey, beatIndex), tag: "volume steady" };
}

// ── question bank — deterministic, rotated by dateKey, max 2/day ─────────────
function buildQuestionBeats(concernBeats, dateKey) {
  const byFlag = {};
  for (const b of concernBeats) {
    const f = b.meta && b.meta.baseFlag ? b.meta.baseFlag : b.flag;
    if (f && !byFlag[f]) byFlag[f] = b;
  }

  const gens = {
    quiet: () => {
      const b = byFlag.quiet;
      if (!b) return null;
      return {
        id: `quiet:${b.athleteId}`,
        text: `Anything going on with ${b.athleteName} outside the gym I should factor in?`,
        chips: ["Season's over", "Schedule crunch", "Not sure — I'll ask"],
      };
    },
    injury: () => {
      const b = byFlag.injury;
      if (!b) return null;
      const area = (b.meta && b.meta.area) || "injury";
      return {
        id: `injury:${b.athleteId}`,
        text: `Has ${b.athleteName}'s ${area} been looked at, or keep flagging it?`,
        chips: ["Being treated", "Keep flagging it"],
      };
    },
    adherence: () => {
      const b = byFlag.adherence;
      if (!b) return null;
      return {
        id: `adherence:${b.athleteId}`,
        text: `Is ${b.athleteName}'s problem schedule or the program?`,
        chips: ["Schedule", "Program's too much", "Not sure"],
      };
    },
    fallback: () => {
      const templates = [
        { text: "What's the main goal for this block?", chips: ["Strength", "Hypertrophy", "Peaking / competition", "Just consistency"] },
        { text: "Where's the team at in the season right now?", chips: ["Off-season", "Pre-season", "In-season", "Post-season"] },
        { text: "How's the team responding to the current program?", chips: ["Fresh, ready for more", "Holding up well", "Getting tired", "Beat up"] },
      ];
      const t = pick(templates, dateKey, 900);
      return { id: "fallback", text: t.text, chips: t.chips };
    },
  };

  const order = ["quiet", "injury", "adherence", "fallback"];
  const rot = hashStr(dateKey) % order.length;
  const rotated = [...order.slice(rot), ...order.slice(0, rot)];

  const picked = [];
  const seenIds = new Set();
  for (const k of rotated) {
    if (picked.length >= 2) break;
    const q = gens[k]();
    if (q && !seenIds.has(q.id)) { picked.push(q); seenIds.add(q.id); }
  }
  return picked.map((q, i) => ({
    id: `question:${i}:${q.id}`,
    kind: "question",
    prose: q.text,
    actions: [],
    question: { id: q.id, text: q.text, chips: q.chips },
  }));
}

/**
 * Build today's deterministic Morning Brief.
 * @param {Object} args
 * @param {Object} args.D CoachOverview memo output (rows/triage/wins/movers/teamAdh/…).
 * @param {Array} args.athletes Full roster rows.
 * @param {Array} [args.changeRequests] Pending program_change_requests rows.
 * @param {Set<string>} [args.cleared] `${athleteId}:${flag}` keys already decided this ISO week.
 * @param {string} args.dateKey "YYYY-MM-DD" local date — the sole source of phrasing variance.
 * @returns {{headline:string, beats:Beat[]}}
 */
export function buildMorningBrief({ D, athletes = [], changeRequests = [], cleared = new Set(), dateKey }) {
  const roster = athletes.length || (D && D.rows ? D.rows.length : 0);
  const beats = [];

  // Empty-roster edge case — nothing to say, don't force templates onto zero data.
  if (!roster) {
    beats.push({
      id: "opening", kind: "opening",
      prose: "No roster loaded yet — the brief will fill in once athletes are added.",
      actions: [],
    });
    beats.push({ id: "allclear", kind: "allclear", prose: "Nothing to review yet.", actions: [] });
    return { headline: "No roster yet", beats };
  }

  const rowsById = {};
  (D.rows || []).forEach((r) => { rowsById[r.a.id] = { ...r, __inactive: D.inactive || [] }; });

  // Rank triage: injury > quiet > adherence (D.triage is only crit-before-warn).
  const kindOrder = { Injury: 0, Quiet: 1, Adherence: 2 };
  const triage = [...(D.triage || [])].sort((a, b) => (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9));

  const pendingReqByAthlete = {};
  for (const r of changeRequests || []) {
    if (r.status === "pending" && !pendingReqByAthlete[r.athlete_id]) pendingReqByAthlete[r.athlete_id] = r;
  }

  const concernBeats = [];
  let bi = 1;
  for (const t of triage) {
    const baseFlag = t.kind === "Injury" ? "injury" : t.kind === "Quiet" ? "quiet" : "adherence";
    if (cleared.has(`${t.id}:${baseFlag}`)) continue;
    const row = rowsById[t.id] || null;
    const req = pendingReqByAthlete[t.id] || null;
    concernBeats.push(buildConcernBeat({ t, row, req, dateKey, beatIndex: bi }));
    bi++;
  }

  // Opening beat — highs first, then how many need attention. No actions.
  const concernCount = concernBeats.length;
  const prThisWk = D.prThisWk || 0;
  const activeCount = D.activeCount || 0;
  const activePct = D.activePct != null ? D.activePct : (roster ? Math.round((100 * activeCount) / roster) : 0);
  const openingTemplates = concernCount > 0
    ? [
        `Morning, Coach. ${prThisWk} true PR${plural(prThisWk)} this week and ${activeCount} of ${roster} have trained. ${concernCount} thing${plural(concernCount)} I'd get in front of today.`,
        `${activeCount} of ${roster} trained this week, ${prThisWk} PR${plural(prThisWk)} banked. ${concernCount} thing${plural(concernCount)} need your eyes today.`,
        `Quick rundown: ${prThisWk} true PR${plural(prThisWk)}, ${activePct}% of the roster active. ${concernCount} spot${plural(concernCount)} worth a look today.`,
      ]
    : [
        `Morning, Coach. ${prThisWk} true PR${plural(prThisWk)} this week and ${activeCount} of ${roster} have trained. Nothing needs you today.`,
        `${activeCount} of ${roster} trained this week, ${prThisWk} PR${plural(prThisWk)} banked, and the roster's clean today.`,
        `Quick rundown: ${prThisWk} true PR${plural(prThisWk)}, ${activePct}% active, all clear today.`,
      ];
  beats.push({ id: "opening", kind: "opening", prose: pick(openingTemplates, dateKey, 0), actions: [] });

  // Concern beats OR all-clear.
  if (concernCount > 0) {
    beats.push(...concernBeats);
  } else {
    beats.push({ id: "allclear", kind: "allclear", prose: "Everything looks healthy — nothing needs you today.", actions: [] });
  }

  // Trend beat — one plain-English sentence, no actions.
  const trend = buildTrendBeat(D, dateKey, 500);
  beats.push({ id: "trend", kind: "trend", prose: trend.text, actions: [] });

  // Question beat(s) — max 2/day.
  beats.push(...buildQuestionBeats(concernBeats, dateKey));

  // Wins beat — always last, only if there's something to show.
  const wins = D.wins || [];
  if (wins.length) {
    const top = wins.slice(0, 2);
    const winTemplates = [
      `Worth sharing: ${top.map((w) => `${w.title} — ${w.detail}`).join(". Also: ")}.`,
      `Something to put in front of the team: ${top.map((w) => `${w.title} — ${w.detail}`).join(". And: ")}.`,
      `Share-worthy this week: ${top.map((w) => `${w.title} — ${w.detail}`).join(". Plus: ")}.`,
    ];
    beats.push({
      id: "wins", kind: "wins", prose: pick(winTemplates, dateKey, 700),
      actions: [
        { id: "share", kind: "share_wins", label: "Share as image" },
        { id: "done", kind: "done", label: "Done" },
      ],
    });
  }

  // Headline for the collapsed card.
  const headline = concernCount > 0
    ? `${concernCount} need${concernCount === 1 ? "s" : ""} you today · ${prThisWk} PR${plural(prThisWk)} · ${trend.tag}`
    : `All caught up · ${prThisWk} PR${plural(prThisWk)} · ${trend.tag}`;

  return { headline, beats };
}

/**
 * Human-readable coach_context note for a taken action, ≤200 chars.
 * @param {Beat} beat
 * @param {string} actionId
 * @param {string} [freeText]
 * @returns {string}
 */
export function decisionNote(beat, actionId, freeText) {
  const action = (beat.actions || []).find((a) => a.id === actionId);
  const actionLabel = (action ? action.label : actionId || "decision").toLowerCase();
  const name = beat.athleteName || "Athlete";
  const meta = beat.meta || {};
  const flag = (meta.baseFlag || beat.flag || "").toLowerCase();

  let detail;
  if (flag === "injury") detail = `${meta.area || "injury"} flagged`;
  else if (flag === "quiet") detail = meta.days != null ? `quiet ${meta.days}d` : "quiet";
  else if (flag === "adherence") detail = meta.score != null ? `adherence ${meta.score}%` : "adherence";
  else if (flag === "request") detail = "program request";
  else detail = beat.kind || "note";

  let note = `${name} ${detail} → coach: ${actionLabel}`;
  if (freeText && String(freeText).trim()) {
    const room = 200 - note.length - 4; // room for ` — "…"` framing
    const ft = room > 3 ? clamp(String(freeText).trim(), room) : "";
    if (ft) note += ` — "${ft}"`;
  }
  return clamp(note, 200);
}
