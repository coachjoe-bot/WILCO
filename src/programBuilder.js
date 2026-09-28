import { campaignLine, parseBlockInfo } from "./programContract.js";
import { PREF_FIELDS } from "./trainingPrefs.js";
import { gateText } from "./replyGate.js";
import { VOICE_ATHLETE, VOICE_COACH, VOICE_FORMAT, VOICE_CLEAN } from "./ai/voice.js";
// ─── PROGRAM BUILDER ENGINE (Phase C) ────────────────────────────────────────
// Pure logic for the interview-driven Program Builder: blueprint cell
// definitions, pre-charge from known data, scope rules, the one-topic doctrine
// router, prompt builders for the three AI roles (interviewer / extractor /
// drafter), and deterministic draft validation. React-free and import-free of
// App.jsx (builder.jsx injects the data/AI helpers), so every rule here is unit
// tested by scripts/test-program-builder-logic.mjs and the credentialed AI
// harness scripts/test-program-build.mjs.
//
// Doctrine loading contract (docs/doctrine/README.md — non-negotiable):
// doctrine-core rides ONLY as the proxy's cached system prefix on Builder /
// draft / merge calls, plus at most ONE topic file chosen by pickTopic().

// ── Blueprint cells ───────────────────────────────────────────────────────────
// why: the one-line Joe-voice reason a question is worth answering — the UI
// shows it under the question. hint: guidance for the interviewer, never shown.
export const ATHLETE_CELLS = [
  { key: "goal", label: "Goal", why: "A goal with a number and a date is a target. Anything else is a wish.",
    hint: "SMART-gated: fills only when specific + measurable + timebound. Push for the number and the date, offer to help pick one if they're vague." },
  { key: "schedule", label: "Schedule", why: "The best program is the one that fits the week you actually have.",
    hint: "Days per week, minutes per session, and weeks until their season starts if they play a sport. Pre-charged from signup — confirm, don't re-ask." },
  { key: "timeline", label: "Timeline", why: "A block without an end date never ends, and never gets judged.",
    hint: "The block's START date and planned END date. ALWAYS propose concrete dates yourself so answering is one tap — anchor on the goal's date, season start, and doctrine block lengths (3-6 weeks). The end date must be REALISTIC for the size of the goal: check their current numbers — a 40 lb bench jump is not a 3-week block; say so and negotiate the date or the goal. Accept relative answers ('3 weeks from now', 'last week of August') and convert them to real dates. Cell value format: 'YYYY-MM-DD to YYYY-MM-DD'." },
  { key: "equipment", label: "Equipment", why: "No program survives contact with a gym that doesn't have the gear it's written for.",
    hint: "What they actually have access to. Pre-charged from signup — confirm, don't re-ask." },
  { key: "red_flags", label: "Red Flags", why: "I'd rather train around something than find out about it in week three.",
    hint: "Injuries, nagging pain, movements a professional told them to avoid. 'None' is a valid, complete answer." },
  { key: "non_negotiables", label: "Non-Negotiables", why: "If there's a lift you love or one you refuse to do, the program should know.",
    hint: "Must-keeps and hard-nos. 'None' is valid and complete." },
  { key: "recovery", label: "Recovery", why: "The program has to fit your life load, not just your gym time.",
    hint: "Sleep, life/school stress, current sport practice hours per week. Practice load changes conditioning volume (core doctrine #1 sequencing mistake)." },
  { key: "prep", label: "Warm-up & Cool-down", why: "Every day I write comes with a warm-up. The only question is whose.",
    hint: "One standard routine vs day-specific vs paste-your-own vs minimal. Never zero — doctrine floor." },
  { key: "handoff", label: "Last Phase", why: "What you just finished tells me where to start.",
    hint: "How the previous phase/program went: what moved, what stalled, what they'd change. Pre-charged from phase history when it exists. If they name a past phase to build off, its recap is already loaded here — confirm what to carry forward." },
];

export const COACH_CELLS = [
  ...ATHLETE_CELLS.filter(c => !["non_negotiables", "recovery"].includes(c.key)),
  { key: "team_destination", label: "Team Destination", why: "Where does this group need to be, and by when?",
    hint: "The team-level outcome and date — season start, playoff push, testing day." },
  { key: "season_map", label: "Season Map", why: "Weeks-to-season drives the whole block sequence.",
    hint: "Off-season / pre-season / in-season now, and key dates. Core doctrine block table keys off this." },
  { key: "team_read", label: "Team Read", why: "You watch them every day. What does the room actually look like?",
    hint: "Coach's own read: effort level, weak points, culture. Free text." },
  { key: "roster_spread", label: "Roster Spread", why: "One program, scaled per athlete. I need the spread, not the average.",
    hint: "Experience range, roughly how many true beginners, standouts. Team doctrine: one shared program scaled by %1RM/RPE, never separate tracks." },
  { key: "weekly_reality", label: "Weekly Reality", why: "Racks, minutes, and bodies. The session I write has to survive your actual room.",
    hint: "Shared window or individual? Headcount vs equipment (max 4 per rack), minutes available. Drives station rotation." },
  { key: "proof", label: "Proof", why: "Pick the tests now so improvement is a fact, not a feeling.",
    hint: "Which tests matter to this coach (majors, vertical, 40) and when to retest (~12-week cycle)." },
  { key: "house_rules", label: "House Rules", why: "Your room, your rules. The program should read like you wrote it.",
    hint: "Coach's non-negotiables, banned movements, formatting/terminology preferences." },
];

// ── Scopes ────────────────────────────────────────────────────────────────────
// full: the whole interview. short: one block, fewer cells. quick: coach-only,
// no SMART gate, straight to draft (athlete quick-builds stay in chat/Field Mode).
export const SCOPE_CELLS = {
  full:  null, // null = every cell for the viewer
  short: ["goal", "schedule", "timeline", "equipment", "red_flags", "handoff"],
  quick: ["goal", "schedule", "equipment"], // one-off session/week — no block timeline
};
// parseTimeline (timeline cell value → {start,end}) lives in programHistory.js —
// App.jsx needs it at save time and already imports that module; this one stays
// the interview-side engine.

export function cellsFor(viewer, scope) {
  const all = viewer === "coach" ? COACH_CELLS : ATHLETE_CELLS;
  const keys = SCOPE_CELLS[scope] || null;
  return keys ? all.filter(c => keys.includes(c.key)) : all;
}

// Blueprint shape: { [cellKey]: {value:string, source:'known'|'interview', pending?:string} }
// A cell counts filled only when it has a non-empty value. `pending` holds a
// not-yet-accepted goal (failed the SMART gate) so the UI can show progress.
export const filledCount = (bp, cells) => cells.filter(c => bp[c.key]?.value?.trim()).length;
export const blueprintPct = (bp, cells) =>
  cells.length === 0 ? 0 : Math.round((filledCount(bp, cells) / cells.length) * 100);

// ── Pre-charge from known data ────────────────────────────────────────────────
// NOTHING arrives accepted. What the app already knows rides as PENDING — the
// tube glows amber at half charge and the interviewer CONFIRMS it in passing
// ("you signed up saying 4 days — still true for this block?"). A new block can
// mean a new schedule, new gear, a finished goal; stale data must never silently
// drive a draft. Confirmation is one word of friction; a wrong program is weeks.
export function precharge({ athlete = {}, goals = [], lastBlock = null, viewer = "athlete", liftProgress = "" }) {
  const bp = {};
  const set = (k, v) => { if (v && String(v).trim()) bp[k] = { value: "", source: "known", pending: String(v).trim() }; };
  // goal additionally passes the SMART gate on top of confirmation.
  const goalText = (goals[0] && (goals[0].goal_text || goals[0].text)) || athlete.goal || "";
  set("goal", goalText);
  const sched = [
    athlete.training_days_per_week ? `${athlete.training_days_per_week} days/week` : "",
    athlete.sport && athlete.season_date ? `season starts ${athlete.season_date}` : "",
  ].filter(Boolean).join(", ");
  set("schedule", sched);
  set("equipment", Array.isArray(athlete.equipment) ? athlete.equipment.join(", ") : athlete.equipment);
  set("red_flags", [athlete.injury_history, athlete.resolved_pain ? "" : ""].filter(Boolean).join("; "));
  if (lastBlock) {
    const range = lastBlock.applied_at ? ` (started ${String(lastBlock.applied_at).slice(0, 10)})` : "";
    // The recap (when a closed block has one) is the richest hand-off there is —
    // it already says what moved and where the goal landed. Short of a formal
    // recap, fold in real lift-progress math from logged history (same
    // first-vs-best e1RM-per-lift computation the main chat already runs) so the
    // interview opens STATING what moved instead of asking from a blank slate
    // (07-29 UX audit fix): the block summary alone names the block, it never
    // says what actually happened during it.
    const progress = liftProgress ? `${liftProgress} this block (from logs)` : "";
    const gist = lastBlock.block_recap
      || [lastBlock.block_summary, progress].filter(Boolean).join(". ")
      || (lastBlock.program_text || "").split("\n").find(l => l.trim())
      || "on record";
    set("handoff", `Previous block${range}: ${gist}`);
  }
  return bp;
}

// ── Doctrine topic router ─────────────────────────────────────────────────────
// ONE topic file per session (cost rule). Priority order is deliberate:
// an injury changes everything (return) > season state (inseason) > group vs
// individual (team) > population (youth) > goal type (conditioning).
export function pickTopic({ blueprint = {}, athlete = {}, viewer = "athlete", scope = "full" }) {
  const txt = (k) => (blueprint[k]?.value || "").toLowerCase();
  const all = Object.values(blueprint).map(c => (c?.value || "")).join(" ").toLowerCase();
  if (/pain|injur|hurt|sore|surgery|rehab|pt\b|tweak/.test(txt("red_flags") + " " + all)) return "return";
  const seasonTxt = txt("schedule") + " " + txt("season_map") + " " + txt("recovery");
  if (/in.?season|mid.?season|games? (every|this)|playing now|season (is )?(underway|started)/.test(seasonTxt)) return "inseason";
  if (viewer === "coach") return "team";
  const age = athlete.age || (athlete.birthday ? Math.floor((Date.now() - new Date(athlete.birthday)) / 3.15576e10) : null);
  if ((age && age < 16) || /first time|never lifted|beginner|new to (lifting|training)/.test(all)) return "youth";
  if (/condition|cardio|endurance|faster|sprint|mile|aerobic/.test(txt("goal") + " " + (blueprint.goal?.pending || "").toLowerCase())) return "conditioning";
  return null;
}

// ── Extractor (Haiku): fill ANY cell from ANY message ────────────────────────
export function extractorSystem(cells, lastQuestion = "") {
  return `You extract training-interview facts into blueprint cells. Cells:
${cells.map(c => `- ${c.key}: ${c.label} — ${c.hint}`).join("\n")}
${lastQuestion ? `THE QUESTION JUST ASKED (the message is an answer to THIS): "${lastQuestion}"
A bare confirmation or short directive ("yes", "sounds good", "split evenly", "do that") answers ONLY this question — fill ONLY the cell this question is about, updated with any detail they gave; if the question maps to no cell, fill NOTHING from such a message. Never let a short answer to one question fill a different cell.` : ""}
Return ONLY JSON: {"cells":{"<key>":"<concise plain-text value>"},"goal_smart":{"ok":boolean,"why":"<what's missing: number/date/specificity>"},"notes":"<optional: a concrete program-relevant fact that fits NO cell>","campaign":[{"n":number,"weeks":number|null,"emphasis":"<short>","checkpoint":"<short>"|null}]|null}
"gate": string|null — populate when a BLOCK GATE / checkpoint for THIS block gets agreed (the athlete accepts a proposed milestone, or states one): a short dated milestone like "bench 3x5 @ 275 by week 4". Only on agreement — a proposal alone is not a gate.
"preference_request": {"field":string,"value":string|number}|null — populate ONLY when the athlete states a DURABLE preference about how their training should be WRITTEN going forward (not a one-off ask for this block). Allowed fields/values: ${Object.entries(PREF_FIELDS).map(([k, f]) => `${k} = ${f.values ? f.values.join("|") : `integer ${f.int[0]}-${f.int[1]}`}`).join("; ")}. One per message, value from the allowed set, else null.
"campaign": populate ONLY when the message lays out (or confirms) a MULTI-BLOCK plan — an ordered sequence of training blocks toward the goal ("11 weeks split into two blocks", "4 weeks strength then 3 weeks peaking", or a yes to a proposed breakdown). One entry per block in order, n starting at 1; weeks when stated; emphasis is the block's focus in a few words; checkpoint is what gates moving to the next block when stated. A single-block timeline is NOT a campaign — leave null. Emitting campaign REPLACES any previously captured campaign, so include every block, not just the changed one.
The timeline cell value MUST be formatted 'YYYY-MM-DD to YYYY-MM-DD' (start to end). Resolve relative dates ("3 weeks from now", "last week of August", "starting Monday") against the Today date given with the message; fill timeline only when the message actually pins the dates down.
Rules: fill EVERY cell this message gives real information for (an expert dumping a full spec can fill many at once); omit cells the message says nothing about; "none"/"no injuries" style answers DO fill their cell with "None"; never invent facts; keep values short and operational. Some cells arrive PENDING — values from the user's profile awaiting confirmation. When the message CONFIRMS a pending value ("yes", "still true", "same as before", or confirms it with a correction), emit that cell with the pending value, updated with any correction they gave. When it REJECTS a pending value, emit the replacement they state (or omit if they gave none yet). goal_smart judges only the goal: ok=true requires specific + measurable (a number) + timebound (a date/timeframe). Include goal_smart ONLY when the message speaks to the goal. Use "notes" sparingly for real facts only (preferences, context the program should honor) — never restate cell values there.`;
}

export function parseExtraction(raw) {
  try {
    const m = String(raw || "").match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : raw);
    const cells = (j && typeof j.cells === "object" && j.cells) || {};
    const out = {};
    for (const [k, v] of Object.entries(cells)) {
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
    let campaign = null;
    if (Array.isArray(j.campaign)) {
      campaign = j.campaign.slice(0, 6).map((b, i) => ({
        n: Number.isInteger(b?.n) && b.n > 0 ? b.n : i + 1,
        weeks: Number.isFinite(Number(b?.weeks)) && Number(b.weeks) > 0 ? Math.min(Number(b.weeks), 16) : null,
        emphasis: String(b?.emphasis || "").slice(0, 60),
        checkpoint: b?.checkpoint ? String(b.checkpoint).slice(0, 80) : null,
      })).filter((b) => b.emphasis);
      if (campaign.length < 2) campaign = null; // one block is a timeline, not a campaign
    }
    return {
      cells: out,
      smart: j.goal_smart && typeof j.goal_smart === "object" ? { ok: !!j.goal_smart.ok, why: String(j.goal_smart.why || "") } : null,
      notes: typeof j.notes === "string" && j.notes.trim() ? j.notes.trim() : null,
      campaign,
      pref: (j.preference_request && typeof j.preference_request === "object" && j.preference_request.field)
        ? { field: String(j.preference_request.field), value: j.preference_request.value } : null,
      gate: typeof j.gate === "string" && j.gate.trim() ? j.gate.trim().slice(0, 80) : null,
    };
  } catch (_) { return { cells: {}, smart: null, notes: null }; }
}

// ── Interviewer (Sonnet, doctrine-cached) ────────────────────────────────────
// Dynamic tail only — doctrine core (+ one topic) rides as the cached prefix.
export function interviewerSystem({ cells, blueprint, scope, viewer, name = "", complete = false, today = "", numbers = "" }) {
  const state = cells.map(c => {
    const b = blueprint[c.key];
    const st = b?.value ? `FILLED (${b.source}): ${b.value}` : b?.pending ? `PENDING (from their profile/history — NOT yet confirmed): ${b.pending}` : "EMPTY";
    return `- ${c.key} (${c.label}): ${st}\n  guidance: ${c.hint}`;
  }).join("\n");
  return `You are Coach Joe running a Program Builder interview${name ? ` with ${name}` : ""}${viewer === "coach" ? " (the user is a COACH building for their athlete/team)" : ""}. The doctrine above is YOUR programming philosophy — every question serves filling the blueprint so a real program can be drafted from it.
${today ? `\nToday is ${today}. Every date you propose or accept must be a real calendar date reasoned from today.` : ""}${numbers ? `\nCURRENT NUMBERS (from their logs and declared maxes, WITH SOURCES): ${numbers}
Treat these as the athlete's real state: a "declared/tested 1RM" is a fact; an "est. from logs" is an estimate, never quote it as tested. If a RECENT MAX ATTEMPTS line is present, those attempts already happened — react to their outcomes, never ask how an attempt went when the log already says.
FEASIBILITY, when a FEASIBILITY line is present (it is code-computed from their logs — trust its numbers over your own arithmetic): use it in the timeline negotiation EXACTLY ONCE. ON TRACK → affirm and move on. TIGHT → say plainly what has to be true. UNREALISTIC → never overrule and never argue twice: the athlete owns their goal. State the numbers once, then propose ONE dated block gate that would settle it partway (a rep milestone, e.g. "bench 3x5 at 275 by week 4") — if they take it, that's the block's gate; if they decline, program their number and drop it. When the line says NOT ENOUGH HISTORY, never claim what their data shows — pace by doctrine only.` : ""}

You are building their NEXT block — the program that comes AFTER whatever they're running now. Never assume it exists to serve the current block's goals: goals get hit, schedules change, focuses shift between blocks. Treat the last/current block as finished context (what worked, what to carry, what to retire). If it's genuinely unclear whether this replaces the current program now or starts when it ends, ask once.

BLUEPRINT (${scope} scope):
${state}${blueprint.__campaign?.length ? `\nCONFIRMED CAMPAIGN (the timeline cell covers Block 1 only): ${campaignLine(blueprint.__campaign, 1)}` : ""}

Rules:
- ONE question per turn, aimed at the most valuable EMPTY (or PENDING) cell. The cell checklist is the spine; the conversation is free — follow up naturally on what they just said before moving on.
- PENDING cells hold what the app already knows — never re-interview from scratch, but never treat them as true either: confirm in passing ("you signed up saying 4 days — still true for this next block?"). You can confirm 2-3 pending cells in one natural question.
- The goal cell is SMART-gated: don't accept a wish. Push warmly for the number and the date; offer a concrete suggestion if they're stuck. If their goal on file looks finished or stale, say so and ask whether to keep chasing it or set a new target.
- CAMPAIGNS (multi-block plans): when the goal's window runs past ~6 weeks, or the athlete describes phases, propose an ordered block breakdown yourself — "Block 1: 4 wk strength (checkpoint: bench 3x5 at 275), Block 2: ..." — and get a yes/no. Once confirmed it's recorded; the timeline cell then covers BLOCK 1 only (the block being drafted now), and later blocks get their own interview when their turn comes. Never churn the timeline through each duration the athlete mentions — long horizons live in the campaign, near dates live in the timeline.
- The timeline cell is how the app knows when this block ENDS — treat it as first-class. Propose concrete start/end dates yourself (goal date, season, 3-6 week doctrine blocks) so answering is one tap. Sanity-check the pairing: if the goal's size doesn't fit the window given their current numbers (a 40 lb bench PR is not a 3-week block), say so plainly and negotiate either the date or the goal before accepting.
- Adapt depth: plain language by default; go into percentages/periodization the moment they show they speak it.
- Voice (the app's one voice source; a program interview is where depth is welcome, never padding):
${viewer === "coach" ? VOICE_COACH : VOICE_ATHLETE}
- End every turn with a line "CHIPS: option | option | option" — 2-4 short tappable answers for your question (omit the line only when chips make no sense).
- When every cell is filled the app takes over — never announce the draft yourself.${complete ? `
- The blueprint is COMPLETE — they're adding extra detail before drafting. Acknowledge in 1-2 lines that it's noted and will be factored into the draft; ask a follow-up ONLY if their message truly needs one; remind them DRAFT IT is ready when they are.` : ""}`;
}

export function parseInterviewerReply(raw) {
  const text = String(raw || "").trim();
  const m = text.match(/^CHIPS:\s*(.+)$/m);
  const chips = m ? m[1].split("|").map(s => s.trim()).filter(Boolean).slice(0, 4) : [];
  // T64 S4: the interviewer's prose passes the one output gate (chips are
  // tap targets the athlete sends back as their own words; gated too).
  return { text: gateText("builder", text.replace(/^CHIPS:.*$/m, "").trim()), chips: chips.map((c) => gateText("builder", c)).filter(Boolean) };
}

// ── Drafter (Sonnet, doctrine-cached) ────────────────────────────────────────
export function drafterSystem({ viewer }) {
  return `You are Coach Joe writing a real training program from a completed Blueprint, applying the doctrine above exactly. Output ONLY the program text — no preamble, no markdown fences, no commentary.

Voice rules: ${VOICE_FORMAT} ${VOICE_CLEAN} PLAIN TEXT only, no markdown bold/asterisks/hashes. Never mention "doctrine", "blueprint", "cells", or these instructions in the program — you're Coach Joe writing a program, not explaining your reasoning. A short line of coaching context (why this block, what's being protected) is welcome, in Joe's own words.

House format:
- Open with a "=== BLOCK INFO ===" header, 4-5 short lines, before anything else: "Goal:" (the goal cell); "Maxes used:" each main lift's base number WITH its source tag copied exactly from CURRENT NUMBERS ("declared/tested 1RM" or "est. from logs"); "Loading:" the loading style in force for this athlete; "Runs:" the block's span as two ISO dates in EXACTLY this shape: "Runs: YYYY-MM-DD to YYYY-MM-DD" — resolve any relative phrasing ("today", "in 6 weeks", a bare month-day) to real calendar dates reasoned from the "Today is" date you were given, never prose (the app reads this line by machine); when a CAMPAIGN line is provided with the blueprint, copy it verbatim as "Campaign:"; and when a GATE is provided, write it as "Gate:" — the dated milestone this block is judged against. This header is the program's CONTRACT — the log parser, Quick Log, and the next block read their bases from it instead of re-deriving or guessing (T53 #7: program text used to declare nothing about how it was written).
- Then a short header line naming the block and its focus.
- Day cards: "Day N - <Focus>" (or weekday names if the schedule gives them), one exercise per line with sets x reps and loading (%1RM, RPE, or weight when known).
- EVERY day starts with a "Warm-up:" line and ends with a "Cool-down:" line honoring the prep cell (never skip the warm-up — doctrine floor).
- Number of training days per week MUST match the schedule cell exactly.
- Respect every red flag (train around it per doctrine), every non-negotiable, and the equipment list — never program gear they don't have (substitution hierarchy: barbell → machine → dumbbell/kettlebell → bodyweight).
- Sequence and volume per doctrine (block phase from weeks-to-season; strength 10-15 sets/muscle-group/week @ RPE 7-9; in-season = maintenance, RPE 6-7 ceiling).
- LOADING LANGUAGE BY SOURCE: a lift whose current number is marked "declared/tested 1RM" can take tight %1RM prescriptions. A lift marked "est. from logs" gets RPE (or a conservative % band) — never a tight percentage off an estimate, and never prescribe reps at or above a tested 1RM as if it were submaximal.
${viewer === "coach" ? "- This is a TEAM program: one shared program scaled per athlete by %1RM/RPE with substitutions for equipment bottlenecks — never separate tracks. Respect max 4 athletes per rack and the weekly_reality cell." : ""}
- 3-6 weeks of content: write week 1 fully, then progression notes per week ("Week 2: +5 lbs on mains", deload trigger per doctrine). If the blueprint's timeline states its own length, THAT length wins over this default — never stretch a stated 3-week block to 4.
- JUDGMENT CALLS (T53 #5): if you deviate from ANYTHING the blueprint states — a swapped movement, trimmed volume, a moved day — end the program with a short "Coach's calls:" list, one line per deviation: what changed, why, and the strict alternative. Never silently drop or alter a stated item, and a non-negotiable is not yours to cut at all — if it truly can't fit, keep it and flag the conflict in Coach's calls instead.`;
}

export function draftUser({ blueprint, cells, athlete = {}, numbers = "" }) {
  const lines = cells.map(c => `${c.label}: ${blueprint[c.key]?.value || "(not specified)"}`);
  const who = [athlete.name, athlete.sport, athlete.age ? `${athlete.age} y/o` : "", athlete.weight_lbs ? `${athlete.weight_lbs} lbs` : ""].filter(Boolean).join(", ");
  // Post-100% conversation lands here: facts that fit no cell still shape the draft.
  const notes = Array.isArray(blueprint.__notes) && blueprint.__notes.length
    ? `\nEXTRA NOTES (honor these too):\n${blueprint.__notes.map(n => `- ${n}`).join("\n")}` : "";
  const nums = numbers ? `\nCURRENT NUMBERS (best estimated 1RMs from logs — base %1RM loading on these): ${numbers}` : "";
  const gate = blueprint.__gate ? `\nGATE (agreed block checkpoint — put it in the header and build the block to arrive there): ${blueprint.__gate}` : "";
  const camp = blueprint.__campaign?.length
    ? `\nCAMPAIGN (confirmed): ${campaignLine(blueprint.__campaign, 1)}\nWrite BLOCK 1 ONLY — its length and emphasis, ending at its checkpoint. Later blocks are drafted when their turn comes; the Campaign header line is how they'll know where they are.`
    : "";
  return `${who ? `ATHLETE: ${who}\n` : ""}BLUEPRINT:\n${lines.join("\n")}${nums}${gate}${camp}${notes}\n\nWrite the program.`;
}

// ── Deterministic draft validation ───────────────────────────────────────────
// The "never ship slop" floor, shared by the runtime retry and the eval harness.
export function validateDraft(text, { blueprint = {}, cells = [] } = {}) {
  const t = String(text || "");
  const problems = [];
  if (t.trim().length < 200) problems.push("draft too short to be a real program");
  // Tolerate leading list/markdown markup on day headers ("**Day 1", "# Day 2",
  // "- Mon") — the live drafter occasionally decorates despite the plain-text rule.
  const dayCount = (t.match(/^[\s#*\-–—]*(day\s*\d|mon|tue|wed|thu|fri|sat|sun)/gim) || []).length;
  const schedM = (blueprint.schedule?.value || "").match(/(\d)\s*days?/i);
  if (schedM && dayCount && dayCount < parseInt(schedM[1], 10)) {
    problems.push(`schedule says ${schedM[1]} days but draft has ${dayCount} day sections`);
  }
  const warmups = (t.match(/warm.?up/gi) || []).length;
  const cooldowns = (t.match(/cool.?down/gi) || []).length;
  if (!warmups) problems.push("no warm-up present");
  if (!cooldowns) problems.push("no cool-down present");
  if (dayCount > 1 && warmups < dayCount) problems.push("not every day has a warm-up");
  const equip = (blueprint.equipment?.value || "").toLowerCase();
  if (/(bodyweight only|no barbell|no gym|dumbbells? only)/.test(equip) && hasBarbellWork(t)) {
    problems.push("barbell work programmed for a no-barbell blueprint");
  }
  // T53 #5: assert the athlete's stated non-negotiables. prescribes() existed for
  // exactly this and only the eval harness called it — which is how WEIGHTED DIPS
  // vanished from a draft with zero validation errors. Must-keeps must appear as
  // real prescriptions; hard-nos must not.
  const nn = (blueprint.non_negotiables?.value || "").trim();
  if (nn && !/^none\b/i.test(nn)) {
    for (const raw of nn.split(/[,;·\n]+/)) {
      const phrase = raw.trim();
      if (phrase.length < 4) continue;
      const isBan = /^(no|never|hard no|avoid|skip|don'?t|not?\s)/i.test(phrase);
      const lift = phrase.replace(/^(keep|must(?: keep| include| have)?|always|no|never|hard no|avoid|skip|don'?t(?: want| do)?|loves?|wants?)\s+/i, "").trim();
      if (lift.length < 4 || !/[a-z]/i.test(lift)) continue;
      const words = lift.split(/\s+/).slice(0, 3).join(" ");
      let re; try { re = new RegExp(words.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&"), "i"); } catch { continue; }
      const present = prescribes(t, re);
      if (isBan && present) problems.push(`hard-no "${words}" is prescribed in the draft`);
      if (!isBan && !present) problems.push(`non-negotiable "${words}" is missing from the draft`);
    }
  }
  // T53 #7 (partial): loading-language conformance, both directions. The prefs
  // record is enum-typed (trainingPrefs.js) and rides on blueprint.__prefs.
  const prefs = blueprint.__prefs || null;
  if (prefs) {
    const presc = t.split("\n").filter(l => /\d\s*[x×]\s*\d|@\s*\d|\bRPE\s*\d|\d+\s*%/.test(l)).join("\n");
    if (prefs.loading_language === "rpe" && /\d+\s*%/.test(presc))
      problems.push("athlete opted out of percentages but the draft prescribes %1RM loading");
    if (prefs.loading_language === "percent" && /\bRPE\s*\d/i.test(presc))
      problems.push("athlete opted out of RPE but the draft prescribes RPE loading");
    if (prefs.loading_language === "fixed_weight" && (/\d+\s*%/.test(presc) || /\bRPE\s*\d/i.test(presc)))
      problems.push("athlete asked for fixed weights but the draft prescribes %/RPE loading");
  }
  return { ok: problems.length === 0, problems };
}

// Does the draft actually PRESCRIBE barbell work? A bare /barbell/ match reads the
// coach's note as a violation — "No barbell means we lean on DB pressing" is the
// drafter obeying the constraint and explaining itself, and it tripped the check on
// a correct program every time it said so. That fired a needless corrective retry
// (a second 3,500-token generation) and then told the model to "fix" a rule it had
// already followed, which is how a good draft gets talked into a worse one.
//
// So: judge PRESCRIPTION lines only, and never a negated mention.
//   • prose paragraphs (the title + coach's note) are not prescriptions
//   • "no barbell", "without a barbell", "instead of a barbell", "sub the barbell"
//     are the constraint being honored, not broken
const NEGATORS = "no|without|instead of|rather than|not|skip(?:ping)?|sub(?:bing|stitute|stituting)?(?: for| out)?|swap(?:ping)?(?: out)?|replace(?:s|d|ment)?(?: for)?|minus|lack(?:ing)?|don'?t have|do not have|don'?t|can'?t use|cannot use|zero|nothing but|other than|besides|never|avoid(?:ing)?";

// Does `banned` appear as an actual PRESCRIPTION, rather than as the drafter
// saying it stayed away from it? Shared by the equipment rule below and the eval
// harness's non-negotiable assertions, because both had the same false positive.
export function prescribes(text, banned, { unless } = {}) {
  const negated = new RegExp(`\\b(?:${NEGATORS})\\b[^.!?\\n]{0,60}?(?:${banned.source})`, "i");
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (!banned.test(line)) continue;
    // The line names a different implement doing the same movement pattern
    // ("DB Flat Bench Press 4x8") — not the banned equipment.
    if (unless && unless.test(line)) continue;
    // Title / coach's-note prose is explanation, not prescription.
    if (/^(coach'?s note|note|title|summary)\b/i.test(line)) continue;
    // A prescription line names sets/reps or a load; prose sentences don't.
    if (!/\d\s*[x×]\s*\d|\bRPE\s*\d|\b\d+\s*%|\breps?\b|\bsets?\b|@\s*\d/i.test(line)) continue;
    // "…no burpees anywhere in this program" is the ban being honored, not broken.
    if (negated.test(line)) continue;
    return true;
  }
  return false;
}

// "bench press <number>" / "back squat @" stand in for an unnamed barbell lift —
// but a dumbbell, kettlebell, machine or Smith variant of the same movement is
// exactly what a no-barbell program is SUPPOSED to prescribe, so those lines are
// not violations. ("DB Flat Bench Press 4x8 @ RPE 7" was failing this check.)
const BARBELL = /barbells?|back squat\s*[@\d]|bench press\s*\d/i;
const NOT_A_BARBELL = /\b(db|dumbbells?|kb|kettlebells?|machine|smith|cable|bands?|bodyweight|goblet)\b/i;
export const hasBarbellWork = (text) => prescribes(text, BARBELL, { unless: NOT_A_BARBELL });
