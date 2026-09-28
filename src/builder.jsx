// ─── PROGRAM BUILDER UI (Phase C) ────────────────────────────────────────────
// The Builder subtab of the Program view, shared by athlete (self, unlocked
// only) and coach (per-athlete / team). Lazy-loaded (like coach.jsx) so the
// doctrine text + this UI never ride the normal boot. All rules/prompts live in
// src/programBuilder.js; this file is the interview loop + power-cell console.
//
// AI calls (all through /api/claude): interviewer + extractor use feature
// "program_build"; generation uses "program_draft"; scoped draft edits reuse
// the shipped "program_apply_change" contract (mergeGuard + lineDiff).
// Doctrine rides ONLY as the cached system prefix on these calls (cost rule).
//
// Session persistence contract (the beta-week lesson — three separate bugs came
// from getting this wrong):
// - park() NEVER clears draft_text: an interview park after a draft exists must
//   not nuke the draft (that's exactly how Will's first draft died).
// - With no initialDraft, the pane AUTO-RESUMES the latest open draft row from
//   the DB instead of opening a fresh (token-spending) interview.
// - Draft generation runs in a MODULE-scope registry (GEN): it keeps writing
//   after the pane unmounts and parks the finished draft straight to the DB, so
//   leaving the tab never loses a draft.
import { useState, useEffect, useMemo, useRef } from "react";
import { CA, CA_BTN, DISP, IS_DARK, PAPER_GRID, Skeleton, askClaude, sbDelete, sbInsert, sbRead, sbUpdateWhere, sbUpsert, track } from "./App.jsx";
import { epley1RM, normalizeExName, toLbs, computeGritSnapshot, ratioLimitersLine, feasibilityLine } from "./grit.js";
import { normalizePrefs, prefsPromptLines, validatePref, describePref, nextSignalState, clearedSignal } from "./trainingPrefs.js";
import { campaignLine, parseBlockInfo } from "./programContract.js";
import { diffStats, lineDiff, mergeGuard } from "./programDiff.js";
import { parseTimeline } from "./programHistory.js";
import {
  cellsFor, blueprintPct, filledCount, precharge, pickTopic,
  extractorSystem, parseExtraction, interviewerSystem, parseInterviewerReply,
  drafterSystem, draftUser, validateDraft,
} from "./programBuilder.js";
import DOC_CORE from "../docs/doctrine/doctrine-core.md?raw";
import DOC_INSEASON from "../docs/doctrine/doctrine-inseason.md?raw";
import DOC_TEAM from "../docs/doctrine/doctrine-team.md?raw";
import DOC_YOUTH from "../docs/doctrine/doctrine-youth.md?raw";
import DOC_CONDITIONING from "../docs/doctrine/doctrine-conditioning.md?raw";
import DOC_RETURN from "../docs/doctrine/doctrine-return.md?raw";

const TOPICS = { inseason: DOC_INSEASON, team: DOC_TEAM, youth: DOC_YOUTH, conditioning: DOC_CONDITIONING, return: DOC_RETURN };
// Cached prefix = core + at most ONE topic. The prefix must be byte-identical
// across a session's calls to actually hit Anthropic's cache, so the topic is
// LOCKED at first pick (locking to first pick also keeps the router cheap).
const doctrineFor = (topic) => DOC_CORE + (topic && TOPICS[topic] ? `\n\n${TOPICS[topic]}` : "");

// Power-cell CSS — the GSA .hcell battery tube verbatim (coach.jsx never mounts
// GSA, so the Builder carries its own copy; identical class rules, so double
// injection on the athlete side is a no-op). bscan = the drafting screen's
// indeterminate charge sweep.
const BUILDER_CSS = `
${IS_DARK?`
/* ORIGINAL dark power cell + scanner, restored verbatim 08-11 (source 6c8737d). */
.htube{height:20px;border:1.5px solid ${CA.line2};border-radius:6px;position:relative;overflow:hidden;background:linear-gradient(180deg,#070d18,#05080f);}
.htube::after{content:"";position:absolute;right:-4px;top:50%;transform:translateY(-50%);width:4px;height:9px;border-radius:2px;background:${CA.line2};}
.hfill{position:absolute;left:0;top:0;bottom:0;width:100%;transform:scaleX(0);transform-origin:left;background:linear-gradient(90deg,color-mix(in srgb,var(--tc) 62%,#000),var(--tc));box-shadow:0 0 calc(8px + var(--tb,0)*22px) var(--tc);filter:brightness(calc(1 + var(--tb,0)*0.9)) saturate(calc(1 + var(--tb,0)*0.4));transition:transform 1.05s cubic-bezier(.3,.8,.3,1);}
.hfill::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,rgba(0,0,0,.28) 0 13px,transparent 13px 16px);opacity:.45;}
.hcell.go .hfill{transform:scaleX(var(--pct,0));}
@keyframes bscan{0%{transform:translateX(-105%);}100%{transform:translateX(305%);}}
.bscan{position:absolute;top:0;bottom:0;width:34%;background:linear-gradient(90deg,transparent,${CA.accent},transparent);box-shadow:0 0 18px ${CA.accent};animation:bscan 1.5s ease-in-out infinite;}
`:`
.htube{height:20px;border:1.5px solid ${CA.line2};border-radius:6px;position:relative;overflow:hidden;background:${CA.navy3};}
.htube::after{content:"";position:absolute;right:-4px;top:50%;transform:translateY(-50%);width:4px;height:9px;border-radius:2px;background:${CA.line2};}
.hfill{position:absolute;left:0;top:0;bottom:0;width:100%;transform:scaleX(0);transform-origin:left;background:var(--tc);transition:transform 1.05s cubic-bezier(.3,.8,.3,1);}
.hcell.go .hfill{transform:scaleX(var(--pct,0));}
@keyframes bscan{0%{transform:translateX(-105%);}100%{transform:translateX(305%);}}
.bscan{position:absolute;top:0;bottom:0;width:34%;background:linear-gradient(90deg,transparent,${CA.accent},transparent);opacity:.5;animation:bscan 1.5s ease-in-out infinite;}
`}
@keyframes bfade{0%{opacity:0;transform:translateY(3px);}12%{opacity:1;transform:none;}88%{opacity:1;}100%{opacity:0;}}
.bline{animation:bfade 2.6s ease-in-out both;}
@media (prefers-reduced-motion: reduce){.hcell.go .hfill{transform:scaleX(var(--pct,0))!important;transition:none!important;}.bscan{animation:none;left:33%;}.bline{animation:none;}}
`;

const nowIso = () => new Date().toISOString();

// ── Background draft generation ───────────────────────────────────────────────
// Keyed by draft row id. The job outlives the pane: it finishes the AI calls,
// parks the finished draft to the row (status "draft"), and leaves its result
// here for whichever mount looks next. Entries are deleted once a pane syncs
// them (the DB row is the durable copy).
const GEN = new Map(); // id -> {status:"running"|"done"|"error", text, promise}

function startGeneration(id, { cached, sys, userPrompt, blueprint, cells }) {
  if (GEN.get(id)?.status === "running") return GEN.get(id);
  const entry = { status: "running", text: "", promise: null };
  entry.promise = (async () => {
    try {
      let text = await askClaude({ cached, dynamic: sys }, userPrompt, 3500, [], "claude-sonnet-5", "program_draft");
      let check = validateDraft(text, { blueprint, cells });
      if (!check.ok) {
        // one corrective retry with the exact failures — the harness asserts the same rules
        text = await askClaude({ cached, dynamic: sys },
          userPrompt + `\n\nYour previous attempt failed these checks — fix ALL of them:\n- ${check.problems.join("\n- ")}`,
          3500, [], "claude-sonnet-5", "program_draft");
        check = validateDraft(text, { blueprint, cells });
      }
      if (!check.ok) console.error("[builder] draft failed validation after retry:", check.problems);
      entry.text = String(text || "").trim();
      // Park straight to the DB — this is what makes leaving the tab safe.
      await sbUpdateWhere("program_drafts", `?id=eq.${id}`, { status: "draft", draft_text: entry.text, updated_at: nowIso() });
      entry.status = "done";
    } catch (e) {
      console.error("[builder] background draft failed:", e?.message || e);
      entry.status = "error";
    }
  })();
  GEN.set(id, entry);
  return entry;
}

const todayStr = () => new Date().toISOString().slice(0, 10);

// The CURRENT NUMBERS block is built in the `numbers` memo inside the pane —
// computeGritSnapshot (the app's ONE max-resolution engine) + source labels +
// the ratio-sheet limiters. See T53 #1/#4.

// T55: recent max ATTEMPTS from the logs — the parser routes every attempt
// (made AND missed) exclusively to parsed_data.pr_attempts, which the Builder
// never read; that's why it asked "how'd the bench max go?" about an attempt
// already in the log.
function recentAttemptsLine(rows) {
  const out = [];
  for (const w of (Array.isArray(rows) ? rows : []).slice(0, 12)) {
    let pd = w?.parsed_data;
    if (typeof pd === "string") { try { pd = JSON.parse(pd); } catch { pd = null; } }
    for (const a of (pd && Array.isArray(pd.pr_attempts)) ? pd.pr_attempts : []) {
      if (!a?.exercise || !a.weight) continue;
      // Full weekday+date computed HERE — a bare "08-16" made the interviewer
      // derive the weekday itself and it called a Sunday attempt "Tuesday" (T57).
      const dt = new Date(w.created_at || 0);
      const d = isNaN(dt.getTime()) ? "" : dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      out.push(`${a.exercise} ${a.weight}${a.unit === "kg" ? "kg" : " lb"}${a.reps > 1 ? ` x${a.reps}` : ""} on ${d}: ${a.achieved === false ? "MISSED" : "made"}`);
      if (out.length >= 6) return out.join("; ");
    }
  }
  return out.join("; ");
}

// Lift-progress delta for the Builder's "Last Phase" hand-off (07-29 UX audit
// fix): first-vs-best e1RM per lift, scoped to logs since the block started, so
// precharge() can open the interview stating what actually moved instead of
// asking a question the app can already answer from the athlete's own logs.
function liftDeltaLine(rows, sinceIso) {
  const since = sinceIso ? new Date(sinceIso).getTime() : 0;
  const inBlock = (Array.isArray(rows) ? rows : [])
    .filter(w => { const t = new Date(w.created_at || w.effective_date || 0).getTime(); return Number.isFinite(t) && t >= since; })
    .sort((a, b) => new Date(a.created_at || a.effective_date) - new Date(b.created_at || b.effective_date));
  const byLift = {}; // canonical name -> {first e1RM logged this block, best since}
  for (const w of inBlock) {
    for (const e of w?.parsed_data?.exercises || []) {
      if (!e?.name || !e.weight || !e.reps) continue;
      const est = epley1RM(toLbs(Number(e.weight), e.unit), Number(e.reps));
      if (!est || !Number.isFinite(est)) continue;
      const k = normalizeExName(e.name);
      if (!byLift[k]) byLift[k] = { name: e.name, first: est, best: est };
      else if (est > byLift[k].best) byLift[k].best = est;
    }
  }
  return Object.values(byLift)
    .filter(x => Math.round(x.best) !== Math.round(x.first))
    .sort((a, b) => (b.best - b.first) - (a.best - a.first))
    .slice(0, 4)
    .map(x => `${x.name} ${Math.round(x.first)}→${Math.round(x.best)}`)
    .join(", ");
}

const DRAFTING_LINES = [
  "Reading your blueprint…",
  "Checking the schedule against the doctrine…",
  "Blocking out the week…",
  "Writing week 1, day by day…",
  "Setting loads and progressions…",
  "Adding every warm-up and cool-down…",
  "Final pass, checking the details…",
];

// saveTarget: "program" (default) applies the finished draft to the athlete's
// live program behind a line-diff confirm. "library" (coach Programs tab, G8)
// hands the draft to onSaveToProgram with NO diff gate — a library save
// replaces nothing, so there is nothing to review against.
export function ProgramBuilderPane({ athlete, viewer = "athlete", coachId = null, initialDraft = null, rebuildFrom = null, locked = false, workoutHistory = [], onSaveToProgram, onParked, saveTarget = "program" }) {
  // Individuals get ONE version — the full interview. short/quick are coach
  // tools (draft today's session / a one-week plan fast for a roster).
  const scopes = viewer === "coach" ? ["full", "short", "quick"] : ["full"];
  const [scope, setScope] = useState(() => {
    const s = initialDraft?.scope || "full";
    return scopes.includes(s) ? s : "full";
  });
  const [blueprint, setBlueprint] = useState(initialDraft?.blueprint || null); // null until precharge/resume
  const [transcript, setTranscript] = useState(initialDraft?.transcript || []);
  const [phase, setPhase] = useState(initialDraft?.status === "draft" ? "draft" : initialDraft ? "interview" : "boot"); // boot|interview|drafting|draft|saved
  const [draftText, setDraftText] = useState(initialDraft?.draft_text || "");
  const [chips, setChips] = useState([]);
  const [prefOffer, setPrefOffer] = useState(null); // {field,value} — durable-preference proposal; persists only on the explicit tap (T53 #3)
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [go, setGo] = useState(false);           // benchGo idiom: cells charge shortly after mount
  const [editReq, setEditReq] = useState("");     // "Tell Joe what to change" input
  const [confirmSave, setConfirmSave] = useState(null); // diff view before Save to My Program
  const [resetArm, setResetArm] = useState(false);
  // Blueprint console shows only the open cells by default (see the renderer below).
  const [cellsExpanded, setCellsExpanded] = useState(false);
  const [draftLine, setDraftLine] = useState(0);  // rotating status line while drafting
  const topicRef = useRef(initialDraft?.blueprint?.__topic || null); // locked at first pick (cache-identity)
  // Build-off-a-named-phase (Will, 07-27): past phases aren't browsable UI —
  // referencing one BY NAME in the interview ("base it on Summer Grind") loads
  // its recap into the hand-off cell and its program text as the draft template.
  const phasesRef = useRef([]);       // recent named phases {id, block_name, recap, summary, program_text}
  const templateRef = useRef(null);   // the matched phase whose text seeds the draft
  const draftIdRef = useRef(initialDraft?.id || null);
  const parkChain = useRef(Promise.resolve());    // serializes parks → exactly one row per session
  const bootRef = useRef({ goals: [], lastBlock: null }); // kept for reset re-precharge
  const scrollRef = useRef(null);
  const cells = cellsFor(viewer, scope);
  const pct = blueprint ? blueprintPct(blueprint, cells) : 0;
  // T53 #1/#2: the resolved-max context (manual_one_rms + prs) and the rolling
  // athlete_context notes that chat and the coach side already read — the Builder
  // was the one feature blind to both.
  const [liftContext, setLiftContext] = useState({ manual: [], prs: [], notes: "", prefs: null, prefsRow: null });
  useEffect(() => {
    let on = true;
    (async () => {
      const [m, p, ctx, pf] = await Promise.all([
        sbRead("manual_one_rms", `?athlete_id=eq.${athlete.id}`).catch(() => []),
        sbRead("prs", `?athlete_id=eq.${athlete.id}&select=exercise,estimated_1rm,weight,reps,unit`).catch(() => []),
        sbRead("athlete_context", `?athlete_id=eq.${athlete.id}&select=content&limit=1`).catch(() => []),
        sbRead("athlete_training_prefs", `?athlete_id=eq.${athlete.id}&limit=1`).catch(() => []),
      ]);
      if (!on) return;
      setLiftContext({
        manual: Array.isArray(m) ? m : [],
        prs: Array.isArray(p) ? p : [],
        notes: (Array.isArray(ctx) && ctx[0]?.content) ? String(ctx[0].content).slice(0, 1200) : "",
        prefs: (Array.isArray(pf) && pf[0]) ? normalizePrefs(pf[0]) : null,
        prefsRow: (Array.isArray(pf) && pf[0]) || null,
      });
    })();
    return () => { on = false; };
  }, [athlete.id]);
  const numbers = useMemo(() => {
    let line = "", limiters = "";
    try {
      const snap = computeGritSnapshot(Array.isArray(workoutHistory) ? workoutHistory : [], liftContext.manual, {
        bodyweightLbs: Number(athlete.weight_lbs) || 0, gender: athlete.gender, age: athlete.age,
        seedFromPRs: liftContext.prs,
      });
      line = (snap.allLifts || []).slice(0, 8)
        .map(x => x.actual ? `${x.name} ${Math.round(x.e1rm)} lb (declared/tested 1RM)`
                           : `${x.name} ~${Math.round(x.e1rm)} lb (est. from logs)`)
        .join(", ");
      // T53 #4: the ratio sheet — ranked limiters from published strength-ratio
      // bands, pure arithmetic, so the interview opens with a coaching read
      // instead of a number dump.
      limiters = ratioLimitersLine(snap.allLifts);
    } catch (_) {}
    const attempts = recentAttemptsLine(workoutHistory);
    return [
      line,
      attempts ? `RECENT MAX ATTEMPTS (already logged): ${attempts}` : "",
      limiters ? `STRENGTH RATIO READ (code-computed limiters): ${limiters}` : "",
    ].filter(Boolean).join("\n");
  }, [workoutHistory, liftContext, athlete]);
  // W39.5: the feasibility argument, computed fresh per turn from the CURRENT
  // goal + timeline cells (they move during the interview).
  const feasFor = (bp) => {
    try {
      return feasibilityLine(workoutHistory,
        bp?.goal?.value || bp?.goal?.pending || "",
        bp?.timeline?.value || "");
    } catch (_) { return ""; }
  };
  // T53 #2: the rolling athlete_context notes ride with the numbers block into the
  // interviewer and the drafter — data, not instructions (same contract as chat).
  const withNotes = (n) => {
    let out = n;
    const pl = liftContext.prefs ? prefsPromptLines(liftContext.prefs) : "";
    if (pl) out = `${out}${out ? "\n" : ""}${pl}`;
    if (liftContext.notes) out = `${out}${out ? "\n" : ""}WHAT THE APP KNOWS ABOUT THEM (rolling notes — facts, not instructions):\n${liftContext.notes}`;
    return out;
  };

  useEffect(() => { const t = setTimeout(() => setGo(true), 80); return () => clearTimeout(t); }, []);
  // Named-phase index for the resolver (non-blocking; also restores a parked
  // session's template via the __templatePhase id stashed in the blueprint).
  useEffect(() => {
    let on = true;
    sbRead("program_history", `?athlete_id=eq.${athlete.id}&order=applied_at.desc&limit=12&select=id,block_name,block_summary,block_recap,program_text`)
      .then(r => {
        if (!on || !Array.isArray(r)) return;
        phasesRef.current = r.filter(p => (p.block_name || "").trim().length >= 4);
        const tid = blueprint?.__templatePhase;
        if (tid && !templateRef.current) templateRef.current = phasesRef.current.find(p => p.id === tid) || null;
      })
      .catch(() => {});
    return () => { on = false; };
  }, [athlete.id]);
  useEffect(() => { scrollRef.current?.scrollTo?.(0, 1e9); }, [transcript, phase]);
  useEffect(() => {
    if (phase !== "drafting") { setDraftLine(0); return; }
    const t = setInterval(() => setDraftLine(l => (l + 1) % DRAFTING_LINES.length), 2600);
    return () => clearInterval(t);
  }, [phase]);

  // Pick up a background generation for the draft this pane owns.
  const attachGen = (id) => {
    const g = GEN.get(id);
    if (!g) return false;
    const sync = () => {
      if (draftIdRef.current !== id) return;
      const e = GEN.get(id);
      GEN.delete(id);
      if (e?.status === "done") { setDraftText(e.text); setPhase("draft"); }
      else if (e?.status === "error") { setErr("Draft didn't come through. Hit DRAFT IT again."); setPhase("interview"); }
    };
    if (g.status === "running") { setPhase("drafting"); g.promise.then(sync, sync); }
    else sync();
    return true;
  };

  // ── Boot: resume the open session if one exists, else pre-charge fresh ──────
  useEffect(() => {
    if (blueprint) { // resumed via initialDraft — just check for a running generation
      if (phase === "boot") setPhase("interview");
      if (draftIdRef.current) attachGen(draftIdRef.current);
      return;
    }
    let on = true;
    (async () => {
      // "Rebuild from this": a chosen past block IS the hand-off — skip the
      // latest-block fetch and anchor the interview on the block they picked.
      let lastBlock = rebuildFrom, goals = [];
      let resumeRow = null;
      const ownerFilter = viewer === "coach" ? "coach" : "athlete";
      if (!rebuildFrom) {
        // Auto-resume: the latest open session is THE session. Every parked turn
        // is in the row, so nothing regenerates and no tokens are re-spent.
        try {
          const r = await sbRead("program_drafts", `?athlete_id=eq.${athlete.id}&owner_type=eq.${ownerFilter}&status=in.("interview","draft")&order=updated_at.desc&limit=1&select=*`);
          resumeRow = (Array.isArray(r) && r[0]) || null;
        } catch (_) {}
      }
      if (!on) return;
      if (resumeRow && resumeRow.blueprint) {
        draftIdRef.current = resumeRow.id;
        topicRef.current = resumeRow.blueprint.__topic || null;
        if (scopes.includes(resumeRow.scope)) setScope(resumeRow.scope);
        setBlueprint(resumeRow.blueprint);
        let t = Array.isArray(resumeRow.transcript) ? resumeRow.transcript : [];
        // T55: the parked opener replays forever — an opener written days ago
        // kept asking about a bench max the athlete had already attempted. When
        // training was logged since the session was parked, say so once (the
        // interviewer's own context is rebuilt fresh every turn; this line keeps
        // the visible transcript honest too).
        const FRESH_NOTE = "You've logged training since we last worked on this — I've pulled in your latest numbers and attempts. If anything changed the picture, tell me and I'll fold it in.";
        const newestLog = Date.parse(workoutHistory?.[0]?.created_at || 0) || 0;
        const parkedAt = Date.parse(resumeRow.updated_at || 0) || 0;
        if (t.length && newestLog > parkedAt && t[t.length - 1]?.content !== FRESH_NOTE) {
          t = [...t, { role: "assistant", content: FRESH_NOTE }];
        }
        setTranscript(t);
        setDraftText(resumeRow.draft_text || "");
        if (!attachGen(resumeRow.id)) setPhase(resumeRow.status === "draft" && resumeRow.draft_text ? "draft" : "interview");
        if (!(Array.isArray(resumeRow.transcript) && resumeRow.transcript.length)) openInterview(resumeRow.blueprint, scopes.includes(resumeRow.scope) ? resumeRow.scope : scope);
        return;
      }
      if (!lastBlock) {
        try {
          const h = await sbRead("program_history", `?athlete_id=eq.${athlete.id}&order=applied_at.desc&limit=1&select=block_summary,block_recap,program_text,applied_at`);
          lastBlock = (Array.isArray(h) && h[0]) || null;
        } catch (_) {}
      }
      try {
        const g = await sbRead("athlete_goals", `?athlete_id=eq.${athlete.id}&order=created_at.desc&limit=1`);
        goals = Array.isArray(g) ? g : [];
      } catch (_) {}
      if (!on) return;
      bootRef.current = { goals, lastBlock: rebuildFrom ? null : lastBlock };
      const bp = precharge({ athlete, goals, lastBlock, viewer, liftProgress: liftDeltaLine(workoutHistory, lastBlock?.applied_at) });
      // T53 #8: the finished block's own header knows the campaign — open the
      // next interview stating which block comes next instead of starting cold.
      try {
        const info = parseBlockInfo(lastBlock?.program_text);
        const cur = info.campaign?.find(b => b.current);
        const next = cur && info.campaign.find(b => b.n === cur.n + 1);
        if (next) bp.handoff = { value: "", source: "known",
          pending: `${bp.handoff?.pending || bp.handoff?.value || ""}${bp.handoff ? " · " : ""}Campaign on file: next up is Block ${next.n}${next.weeks ? ` (${next.weeks} wk)` : ""} — ${next.emphasis}${next.checkpoint ? `, checkpoint: ${next.checkpoint}` : ""}` };
      } catch (_) {}
      if (rebuildFrom) {
        const name = rebuildFrom.block_summary || (rebuildFrom.program_text || "").split("\n").find(l => l.trim()) || "a previous block";
        bp.handoff = { value: `REBUILD of a past block: ${name}. Its full text is the starting template. Keep what worked, change what the interview surfaces.`, source: "known" };
      }
      setBlueprint(bp);
      setPhase("interview");
      openInterview(bp, scope);
    })();
    return () => { on = false; };
  }, [athlete.id]);

  const doctrine = () => {
    if (!topicRef.current) topicRef.current = pickTopic({ blueprint: blueprint || {}, athlete, viewer, scope }) || "none";
    return doctrineFor(topicRef.current === "none" ? null : topicRef.current);
  };

  const transcriptText = (t) => t.slice(-12).map(m => `${m.role === "user" ? (viewer === "coach" ? "Coach" : "Athlete") : "Joe"}: ${m.content}`).join("\n");

  // ── Persistence: park after every assistant turn (crash-safe interview) ────
  // Serialized on parkChain (no double-insert races) and returns the row id.
  // dText=null means "no new draft text" — an existing draft_text is NEVER
  // overwritten with null.
  const park = (bp, t, status, dText) => {
    const run = async () => {
      const row = {
        owner_type: viewer, title: bp?.goal?.value ? bp.goal.value.slice(0, 60) : "Builder session",
        status, blueprint: { ...bp, __topic: topicRef.current }, transcript: t,
        provisional_goal: bp?.goal?.value || bp?.goal?.pending || null,
        scope, updated_at: nowIso(),
      };
      if (dText != null) row.draft_text = dText;
      try {
        if (draftIdRef.current) {
          await sbUpdateWhere("program_drafts", `?id=eq.${draftIdRef.current}`, row);
        } else {
          const ins = viewer === "coach"
            ? { ...row, coach_id: coachId, athlete_id: athlete.id }
            : { ...row, athlete_id: athlete.id };
          const res = await sbInsert("program_drafts", ins);
          const id = Array.isArray(res) && res[0]?.id;
          if (id) draftIdRef.current = id;
          else {
            // Gateway inserts don't return rows — recover the id so background
            // generation and future parks target the right row.
            const back = await sbRead("program_drafts", `?athlete_id=eq.${athlete.id}&owner_type=eq.${viewer}&status=in.("interview","draft")&order=updated_at.desc&limit=1&select=id`).catch(() => []);
            if (Array.isArray(back) && back[0]?.id) draftIdRef.current = back[0].id;
          }
        }
      } catch (e) { console.error("[builder] park failed:", e?.message || e); }
      return draftIdRef.current;
    };
    parkChain.current = parkChain.current.then(run, run);
    return parkChain.current;
  };

  // ── Interview turns ────────────────────────────────────────────────────────
  const openInterview = async (bp, sc) => {
    setBusy(true); setErr("");
    try {
      const sys = interviewerSystem({ cells: cellsFor(viewer, sc), blueprint: bp, scope: sc, viewer, name: athlete.name, today: todayStr(), numbers: withNotes([numbers, feasFor(bp)].filter(Boolean).join("\n")) });
      const raw = await askClaude({ cached: doctrine(), dynamic: sys }, "Open the interview: greet in one short line, then your first question.", 400, [], "claude-sonnet-5", "program_build");
      const { text, chips: ch } = parseInterviewerReply(raw);
      const t1 = [{ role: "assistant", content: text }];
      setTranscript(t1);
      setChips(ch);
      // Park the opener too: switching away and back must never re-spend this call.
      park(bp, t1, "interview", null);
    } catch (e) { setErr("Couldn't reach Joe. Try again in a sec."); }
    setBusy(false);
  };

  const send = async (msgArg) => {
    const msg = (typeof msgArg === "string" ? msgArg : input).trim();
    if (!msg || busy || !blueprint) return;
    setInput(""); setChips([]); setBusy(true); setErr("");
    const t1 = [...transcript, { role: "user", content: msg }];
    setTranscript(t1);
    // Read-back confirmed → mark and ack deterministically (no AI turn); any
    // OTHER reply after a read-back falls through to the normal path, where the
    // extractor applies the correction and pct/readback re-run.
    if (msg === READBACK_OK && blueprintPct(blueprint, cells) === 100) {
      const bp2 = { ...blueprint, __readbackOk: true };
      const t2 = [...t1, { role: "assistant", content: "Locked. Hit ⚡ DRAFT IT and I'll write the block." }];
      setBlueprint(bp2); setTranscript(t2); setChips([]);
      park(bp2, t2, "interview", null);
      setBusy(false);
      return;
    }
    // Any substantive message after the read-back invalidates the OK — the
    // blueprint may be about to change, so it gets read back again.
    const bpIn = blueprint.__readbackOk ? { ...blueprint, __readbackOk: false } : blueprint;
    const wasDone = blueprintPct(bpIn, cells) === 100;
    try {
      // 1) extractor — can fill ANY cell from this one message (and confirm
      // pending profile values: "yes, still 4 days" charges the cell).
      const pendings = Object.fromEntries(cells.map(c => [c.key, bpIn[c.key]?.pending || null]).filter(([, v]) => v));
      const lastQ = [...transcript].reverse().find(m => m.role === "assistant")?.content?.slice(0, 400) || "";
      const ex = parseExtraction(await askClaude(
        extractorSystem(cells, lastQ),
        `Today: ${todayStr()}\nCurrent blueprint (JSON): ${JSON.stringify(Object.fromEntries(cells.map(c => [c.key, bpIn[c.key]?.value || null])))}\nPending values awaiting confirmation (JSON): ${JSON.stringify(pendings)}\nMessage: "${msg}"`,
        500, [], "claude-haiku-4-5", "program_build"
      ));
      const bp = { ...bpIn };
      for (const [k, v] of Object.entries(ex.cells)) {
        if (!cells.find(c => c.key === k)) continue;
        if (k === "goal" && scope !== "quick") {
          // SMART gate: the goal cell only fills when specific+measurable+timebound.
          if (ex.smart?.ok) bp.goal = { value: v, source: "interview" };
          else bp.goal = { value: "", source: "interview", pending: v, note: ex.smart?.why || "needs a number and a date" };
        } else {
          bp[k] = { value: v, source: "interview" };
        }
      }
      if (ex.notes) bp.__notes = [...(Array.isArray(bp.__notes) ? bp.__notes : []), ex.notes].slice(-12);
      // T53 #8: a confirmed multi-block plan replaces the whole campaign (the
      // extractor emits every block, so partial edits can't strand stale ones).
      if (ex.campaign) bp.__campaign = ex.campaign;
      if (ex.gate) bp.__gate = ex.gate; // W39.5b: the agreed dated checkpoint this block is judged against
      if (ex.pref) {
        const v = validatePref(ex.pref.field, ex.pref.value);
        const cur = liftContext.prefs ? liftContext.prefs[ex.pref.field] : undefined;
        if (v !== undefined && cur !== v) {
          const st = nextSignalState(liftContext.prefsRow, ex.pref.field, v);
          if (st.autoSet) {
            sbUpsert("athlete_training_prefs", { athlete_id: athlete.id, [ex.pref.field]: v, source: "auto", confirmed_at: nowIso(), updated_at: nowIso(), signals: st.signals }, "athlete_id")
              .then(() => setLiftContext(lc => ({ ...lc, prefs: normalizePrefs({ ...(lc.prefs || {}), [ex.pref.field]: v }), prefsRow: { ...(lc.prefsRow || {}), [ex.pref.field]: v, signals: st.signals } })))
              .catch(() => {});
          } else {
            sbUpsert("athlete_training_prefs", { athlete_id: athlete.id, signals: st.signals, updated_at: nowIso() }, "athlete_id")
              .then(() => setLiftContext(lc => ({ ...lc, prefsRow: { ...(lc.prefsRow || {}), signals: st.signals } })))
              .catch(() => {});
            setPrefOffer({ field: ex.pref.field, value: v });
          }
        }
      }
      // Named-phase resolver: mentioning a past phase by name loads it as the
      // hand-off + draft template. Deterministic substring match — no AI guessing.
      const named = phasesRef.current.find(p => msg.toLowerCase().includes(p.block_name.toLowerCase()));
      if (named && templateRef.current?.id !== named.id) {
        templateRef.current = named;
        bp.__templatePhase = named.id;
        bp.handoff = { value: `Building off the past phase "${named.block_name}": ${named.block_recap || named.block_summary || "on record"}. Its structure is the starting template. Keep what worked, change what this interview surfaces.`, source: "interview" };
      }
      setBlueprint(bp);
      const done = blueprintPct(bp, cells) === 100;
      if (done && !wasDone) {
        postReadback(bp, t1);
      } else {
        // 2) interviewer — next question (or, at 100%, a brief "noted" ack).
        const sys = interviewerSystem({ cells, blueprint: bp, scope, viewer, name: athlete.name, complete: done, today: todayStr(), numbers: withNotes([numbers, feasFor(bp)].filter(Boolean).join("\n")) });
        const raw = await askClaude({ cached: doctrine(), dynamic: sys }, `Conversation so far:\n${transcriptText(t1)}\n\nContinue with your next single question.`, 400, [], "claude-sonnet-5", "program_build");
        const { text, chips: ch } = parseInterviewerReply(raw);
        const t2 = [...t1, { role: "assistant", content: text }];
        setTranscript(t2); setChips(ch);
        park(bp, t2, "interview", null);
      }
    } catch (e) { setErr("Couldn't reach Joe. Your answers are safe, try again."); }
    setBusy(false);
  };

  // ── Read-back gate (T53 #5) ────────────────────────────────────────────────
  // Before anything drafts, the athlete sees the EXACT blueprint being built
  // from and confirms it. Deterministic — zero AI calls — and it catches every
  // extraction error (the "split evenly" → prep-cell fabrication class) at one
  // gate, because a wrong cell is visible right there in the read-back.
  const READBACK_OK = "All correct — lock it in";
  const readbackText = (bp) => {
    const lines = cells.map(c => `${c.label}: ${bp[c.key]?.value?.trim() || "—"}`);
    if (bp.__campaign?.length) lines.push(`Campaign: ${campaignLine(bp.__campaign, 1)} (drafting Block 1 now)`);
    if (bp.__gate) lines.push(`Block gate: ${bp.__gate}`);
    return `Before I write a rep, read this back — it's exactly what I'll draft from:

${lines.join("\n")}

Anything wrong is a one-word fix now and a wasted week later. Good to build?`;
  };
  const postReadback = (bp, t) => {
    const t2 = [...t, { role: "assistant", content: readbackText(bp) }];
    setTranscript(t2); setChips([READBACK_OK, "Fix something"]);
    park({ ...bp, __readbackShown: true }, t2, "interview", null);
    setBlueprint({ ...bp, __readbackShown: true });
  };

  // ── Draft generation (hard rule: never below 100%) ─────────────────────────
  // The pane only STARTS the job — GEN owns it from there. Leaving the tab (or
  // the app) doesn't stop it; the finished draft parks itself to the row.
  const generate = async () => {
    if (busy || pct !== 100) return;
    if (!blueprint.__readbackOk) { postReadback(blueprint, transcript); return; }
    setBusy(true); setErr(""); setPhase("drafting");
    try {
      track("builder_draft_generate", "ai");
      const id = await park(blueprint, transcript, "interview", null);
      if (!id) throw new Error("no draft row");
      const sys = drafterSystem({ viewer });
      // A rebuild or a named-phase reference carries the old phase's full text
      // as the starting template.
      if (liftContext.prefs) blueprint.__prefs = liftContext.prefs;
      let userPrompt = draftUser({ blueprint, cells, athlete, numbers: withNotes([numbers, feasFor(blueprint)].filter(Boolean).join("\n")) });
      const tmpl = rebuildFrom?.program_text || templateRef.current?.program_text;
      if (tmpl) userPrompt += `\n\nPREVIOUS BLOCK (starting template — keep its working structure unless the blueprint says otherwise):\n${tmpl.slice(0, 3000)}`;
      startGeneration(id, { cached: doctrine(), sys, userPrompt, blueprint, cells });
      attachGen(id);
    } catch (e) { setErr("Draft didn't come through. Try DRAFT IT again."); setPhase("interview"); }
    setBusy(false);
  };

  // ── Draft editing: hand-edit OR scoped NL edit (Quick Log contract) ────────
  const tellJoe = async () => {
    const req = editReq.trim();
    if (!req || busy) return;
    setBusy(true); setErr("");
    try {
      const sys = `You are applying ONE change to a training program draft for its owner. Return ONLY the complete updated program text — no preamble, no fences. Make ONLY the change requested; preserve every other line character-for-character; keep the format.`;
      const raw = await askClaude(sys, `CURRENT DRAFT:\n${draftText}\n\nREQUESTED CHANGE: ${req}`, 4000, [], "claude-sonnet-5", "program_apply_change");
      const guard = mergeGuard(draftText, raw);
      if (!guard.ok) { setErr("Couldn't make that change cleanly. Say it more specifically."); }
      else {
        setDraftText(guard.text); setEditReq("");
        park(blueprint, transcript, "draft", guard.text);
      }
    } catch (e) { setErr("Couldn't make that change. Try again."); }
    setBusy(false);
  };

  const saveToProgram = async () => {
    if (busy || (saveTarget !== "library" && !confirmSave)) return;
    setBusy(true); setErr("");
    try {
      // The blueprint's timeline rides along so the save can stamp the new
      // block's start (applied_at) and planned end (ends_at); the blueprint's
      // goal rides too so the apply supersedes the athlete's goal on file (T62).
      await onSaveToProgram(draftText, parseTimeline(blueprint?.timeline?.value), blueprint?.goal?.value||null);
      if (draftIdRef.current) await sbUpdateWhere("program_drafts", `?id=eq.${draftIdRef.current}`, { status: "applied", updated_at: nowIso() }).catch(() => {});
      track("builder_draft_applied", "ai");
      setConfirmSave(null);
      setPhase("saved");
    } catch (e) { setErr("Couldn't save that. Try again in a sec."); }
    setBusy(false);
  };

  // ── Full reset: wipe this session, re-charge from fresh data ───────────────
  // Everything pre-filled returns to unconfirmed pending; the next program
  // starts from new everything. Also the exit door for the "saved" state.
  const resetAll = async () => {
    if (busy) return;
    setBusy(true); setErr(""); setResetArm(false);
    const id = draftIdRef.current;
    draftIdRef.current = null;
    if (id) { GEN.delete(id); await sbDelete("program_drafts", `?id=eq.${id}&status=in.("interview","draft")`).catch(() => {}); }
    topicRef.current = null;
    setTranscript([]); setChips([]); setDraftText(""); setConfirmSave(null); setInput(""); setEditReq("");
    // Re-read goals + last block so a just-finished block hands off correctly.
    let { goals, lastBlock } = bootRef.current;
    try {
      const [g, h] = await Promise.all([
        sbRead("athlete_goals", `?athlete_id=eq.${athlete.id}&order=created_at.desc&limit=1`).catch(() => []),
        sbRead("program_history", `?athlete_id=eq.${athlete.id}&order=applied_at.desc&limit=1&select=block_summary,block_recap,program_text,applied_at`).catch(() => []),
      ]);
      goals = Array.isArray(g) ? g : goals;
      lastBlock = (Array.isArray(h) && h[0]) || lastBlock;
      bootRef.current = { goals, lastBlock };
    } catch (_) {}
    const bp = precharge({ athlete, goals, lastBlock, viewer });
    setBlueprint(bp);
    setPhase("interview");
    setBusy(false);
    openInterview(bp, scope);
  };

  // ── UI atoms ───────────────────────────────────────────────────────────────
  const mono = { fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace" };
  const subhead = { ...mono, fontSize: 9, letterSpacing: 2, color: CA.muted, textTransform: "uppercase" };
  const miniBtn = (active, color = CA.accent) => ({ background: active ? `${color}20` : "transparent", border: `1px solid ${active ? color : CA.border}`, color: active ? color : CA.muted, borderRadius: 8, padding: "5px 11px", cursor: "pointer", fontSize: 11.5, fontWeight: 600, fontFamily:"'Inter'" });
  const priBtn = { background: CA_BTN, color:CA.onAccent, border: "none", borderRadius: 9, padding: "9px 16px", cursor: "pointer", fontSize: 13, fontWeight: 700, ...DISP, letterSpacing: 1 };
  const conversationStarted = Array.isArray(transcript) && transcript.some(m => m.role === "user");
  const cellTube = (charged, pending) => (
    <div className={`hcell${go ? " go" : ""}`}>
      <div className="htube" style={{ height: 10 }}>
        <div className="hfill" style={{ "--pct": charged ? 1 : (pending && conversationStarted) ? 0.45 : 0, "--tc": pending && conversationStarted && !charged ? CA.amber : CA.accent, "--tb": charged ? 0.55 : 0.2 }} />
      </div>
    </div>
  );

  if (viewer === "athlete" && locked) {
    return (
      <div style={{ color: CA.muted2, fontSize: 13, lineHeight: 1.7, padding: "24px 4px", textAlign: "center" }}>
        🔒 Your coach owns your program, so the Builder is their console for you. Want something changed? Use <b>Request a change</b> on the My Program tab.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, height: "100%", minHeight: 0 }}>
      <style>{BUILDER_CSS}</style>

      {/* ── Blueprint console: master cell + sub-cells ──
          Light brand (Draft-2): cream card, ledger-segment master line, field
          CHIPS (green ✓ / · Known, amber · on file, plain open). Dark keeps the
          original HUD console (grey scrim + battery tubes) untouched. */}
      <div style={{ border: `1px solid ${CA.border}`, borderRadius: 12, padding: 13, background: IS_DARK ? "rgba(31,42,55,0.45)" : CA.navy3, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 7 }}>
          <span style={{ ...DISP, fontSize: 15, letterSpacing: 1.5, color: CA.text }}>BLUEPRINT</span>
          <span title="The Builder is brand new. Double-check what Joe writes and tell us if something feels off."
            style={{ ...mono, fontSize: 7.5, letterSpacing: 1, color: CA.amber, border: `1px solid ${CA.amber}88`, borderRadius: 4, padding: "1px 4px" }}>BETA</span>
          <span style={{ ...mono, fontSize: 11, color: pct === 100 ? CA.led : CA.accent }}>{pct}%</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 4, alignItems: "center" }}>
            {scopes.length > 1 && scopes.map(s => (
              <button key={s} disabled={transcript.length > 1} onClick={() => { setScope(s); if (blueprint) openInterview(blueprint, s); }}
                title={transcript.length > 1 ? "Scope locks once the interview starts" : ""}
                style={{ ...miniBtn(scope === s), padding: "2px 8px", fontSize: 9.5, textTransform: "uppercase", letterSpacing: 1, opacity: transcript.length > 1 && scope !== s ? 0.4 : 1 }}>
                {s}
              </button>
            ))}
            {phase !== "boot" && phase !== "drafting" && (resetArm ? (
              <>
                <button onClick={resetAll} disabled={busy} style={{ ...miniBtn(true, CA.red), padding: "2px 8px", fontSize: 9.5 }}>Really reset</button>
                <button onClick={() => setResetArm(false)} style={{ ...miniBtn(false), padding: "2px 8px", fontSize: 9.5 }}>Keep</button>
              </>
            ) : (
              <button onClick={() => setResetArm(true)} title="Wipe this interview and start over. Every pre-filled bar goes back to unconfirmed"
                style={{ ...miniBtn(false), padding: "2px 8px", fontSize: 9.5, textTransform: "uppercase", letterSpacing: 1 }}>
                ↺ Reset
              </button>
            ))}
          </span>
        </div>
        {IS_DARK ? (
          <div className={`hcell${go ? " go" : ""}`} style={{ marginBottom: 10 }}>
            <div className="htube">
              <div className="hfill" style={{ "--pct": pct / 100, "--tc": pct === 100 ? CA.led : CA.accent, "--tb": pct === 100 ? 0.75 : pct / 130 }} />
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 3, marginBottom: 11 }}>
            {Array.from({ length: 8 }, (_, s) => {
              const f = Math.max(0, Math.min(1, (pct / 100) * 8 - s));
              const tc = pct === 100 ? CA.green : CA.accent;
              return (
                <span key={s} style={{ flex: 1, height: 4, borderRadius: 2, background: CA.border, position: "relative", overflow: "hidden" }}>
                  {f > 0 && <span style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: `${f * 100}%`, background: tc }} />}
                </span>
              );
            })}
          </div>
        )}
        {/* Only the cells that still need an answer, up to three, plus one summary
            chip for everything already confirmed (Will, 08-12: the full grid "seems
            like a lot" and ate a big block of space). As each one turns green it
            drops out and the next open cell takes its place, so the console always
            shows the SHORTEST list of what Joe still needs. Tap the summary to see
            everything. Same rule in both themes, each in its own styling. */}
        {(() => {
          const charged = cells.filter(c => !!blueprint?.[c.key]?.value);
          const open = cells.filter(c => !blueprint?.[c.key]?.value);
          const shown = cellsExpanded ? cells : open.slice(0, 3);
          const hidden = cells.length - shown.length;
          const summary = hidden > 0 && (
            <button onClick={() => setCellsExpanded(v => !v)}
              title={cellsExpanded ? "Show only what's left" : "Show every field"}
              style={{ fontSize: 11, fontWeight: 600, fontFamily: "'Inter'", padding: "5px 11px", borderRadius: 999,
                border: `1px dashed ${CA.border}`, color: CA.muted, background: "transparent", cursor: "pointer", whiteSpace: "nowrap" }}>
              {cellsExpanded ? "Show less" : `${charged.length} confirmed · +${hidden} more`}
            </button>
          );
          const expandOnly = cellsExpanded && hidden <= 0 && (
            <button onClick={() => setCellsExpanded(false)}
              style={{ fontSize: 11, fontWeight: 600, fontFamily: "'Inter'", padding: "5px 11px", borderRadius: 999,
                border: `1px dashed ${CA.border}`, color: CA.muted, background: "transparent", cursor: "pointer", whiteSpace: "nowrap" }}>
              Show less
            </button>
          );
          if (IS_DARK) return (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(118px,1fr))", gap: "8px 12px", alignItems: "end" }}>
              {shown.map(c => {
                const b = blueprint?.[c.key];
                const chargedCell = !!b?.value;
                return (
                  <div key={c.key} title={`${c.why}${b?.note ? `\n(${b.note})` : ""}${!chargedCell && b?.pending ? `\nOn file: ${b.pending}. Joe will confirm it with you.` : ""}`}>
                    <div style={{ display: "flex", gap: 5, alignItems: "baseline", marginBottom: 3 }}>
                      <span style={{ fontSize: 10.5, color: chargedCell ? CA.text : CA.muted, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.label}</span>
                      {b?.source === "known" && chargedCell && <span style={{ ...mono, fontSize: 7.5, color: CA.muted }}>KNOWN</span>}
                    </div>
                    {cellTube(chargedCell, !!b?.pending)}
                  </div>
                );
              })}
              {(summary || expandOnly) && <div>{summary || expandOnly}</div>}
            </div>
          );
          return (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              {shown.map(c => {
                const b = blueprint?.[c.key];
                const chargedCell = !!b?.value;
                // T55 (Will's rule): everything sits at zero until a conversation
                // starts — profile data stays parked internally (the extractor
                // still confirms it) but renders nothing before the first answer.
                const onFile = conversationStarted && !chargedCell && !!b?.pending;
                const col = chargedCell ? CA.green : onFile ? CA.amber : CA.muted;
                return (
                  <span key={c.key} title={`${c.why}${b?.note ? `\n(${b.note})` : ""}${onFile ? `\nOn file: ${b.pending}. Joe will confirm it with you.` : ""}`}
                    style={{ fontSize: 11, fontWeight: 600, fontFamily: "'Inter'", padding: "5px 11px", borderRadius: 999, border: `1px solid ${chargedCell || onFile ? col : CA.border}`, color: col, background: CA.navy2, whiteSpace: "nowrap" }}>
                    {c.label}{chargedCell ? (b?.source === "known" ? " · Known" : " ✓") : onFile ? " · on file" : ""}
                  </span>
                );
              })}
              {summary || expandOnly}
            </div>
          );
        })()}
      </div>

      {/* ── Scheduled state: future start date → parked, not applied ── */}
      {phase === "scheduled" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ border: `1px solid ${CA.accent}55`, background: `${CA.accent}0d`, borderRadius: 12, padding: 16, color: CA.text, fontSize: 13, lineHeight: 1.7 }}>
            📅 Scheduled. This program is parked in <b>Drafts</b>, planned for <b>{parseTimeline(blueprint?.timeline?.value).start}</b>. When the date comes (or your current phase wraps), Joe offers to swap it in with one tap. Want it sooner? Apply it any time from Drafts.
          </div>
          <div>
            <button onClick={resetAll} style={priBtn}>START A NEW PROGRAM</button>
          </div>
        </div>
      )}

      {/* ── Saved state ── */}
      {phase === "saved" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ border: `1px solid ${CA.green}55`, background: `${CA.green}0d`, borderRadius: 12, padding: 16, color: CA.text, fontSize: 13, lineHeight: 1.7 }}>
            {saveTarget === "library"
              ? <>✅ Saved to your library. Put it on any athlete from the <b>Library</b> tab whenever you're ready.</>
              : <>✅ Saved to {viewer === "coach" ? `${athlete.name}'s program` : "My Program"} . It drives every session from here. The old phase is archived under Phases.</>}
          </div>
          <div>
            <button onClick={resetAll} style={priBtn}>START A NEW PROGRAM</button>
          </div>
        </div>
      )}

      {/* ── Drafting: Joe writes in the background — leaving is safe ── */}
      {phase === "drafting" && (
        <div style={{ border: `1px solid ${CA.border}`, borderRadius: 12, padding: "22px 18px", background: IS_DARK ? "rgba(31,42,55,0.45)" : CA.navy3, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ ...DISP, fontSize: 17, letterSpacing: 2, color: CA.text }}>⚡ JOE'S WRITING YOUR BLOCK</div>
          <div className="htube" style={{ height: 14 }}>
            <div className="bscan" />
          </div>
          <div key={draftLine} className="bline" style={{ ...mono, fontSize: 12, color: CA.accent, minHeight: 18 }}>{DRAFTING_LINES[draftLine]}</div>
          <div style={{ color: CA.muted, fontSize: 11.5, lineHeight: 1.6 }}>
            You don't have to watch. Leave this tab and Joe keeps writing. The finished draft lands in <b>Drafts</b>.
          </div>
        </div>
      )}

      {/* ── Draft view ── */}
      {phase === "draft" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
          {confirmSave ? (
            <div style={{ overflowY: "auto" }}>
              <div style={subhead}>Review: replaces the current program</div>
              <div style={{ border: `1px solid ${CA.border}`, borderRadius: 10, background: IS_DARK ? "rgba(31,42,55,0.4)" : CA.navy2, padding: "10px 12px", maxHeight: 260, overflowY: "auto", margin: "8px 0 10px" }}>
                {confirmSave.map((d, i) => (
                  <div key={i} style={{ ...mono, fontSize: 11.5, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word", color: d.type === "add" ? CA.green : d.type === "del" ? CA.red : CA.muted, opacity: d.type === "same" ? 0.55 : 1 }}>
                    {d.type === "add" ? "+ " : d.type === "del" ? "− " : "  "}{d.text || " "}
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={saveToProgram} disabled={busy} style={{ ...priBtn, background: busy ? CA.navy3 : CA_BTN, color:busy ? CA.muted : CA.onAccent, cursor: busy ? "wait" : "pointer" }}>{busy ? "SAVING…" : "REPLACE PROGRAM"}</button>
                <button onClick={() => setConfirmSave(null)} style={miniBtn(false)}>Back to draft</button>
              </div>
            </div>
          ) : (
            <>
              <div style={subhead}>Draft: edit by hand, or tell Joe what to change</div>
              <textarea value={draftText} onChange={e => setDraftText(e.target.value)} rows={14}
                style={{ flex: 1, minHeight: 180, width: "100%", boxSizing: "border-box", background: "rgba(58,123,255,0.03)", border: `1px solid ${CA.line2}`, borderRadius: 10, padding: "10px 12px", color: CA.text, fontSize: 12, outline: "none", resize: "vertical", lineHeight: 1.7, ...mono, ...PAPER_GRID }} />
              <div style={{ display: "flex", gap: 6 }}>
                <input value={editReq} onChange={e => setEditReq(e.target.value)} onKeyDown={e => { if (e.key === "Enter") tellJoe(); }}
                  placeholder='Tell Joe what to change: "swap day 2 to dumbbells"'
                  style={{ flex: 1, background: CA.navy3, border: `1px solid ${CA.border}`, borderRadius: 9, padding: "8px 11px", color: CA.text, fontSize: 12, outline: "none", fontFamily:"'Inter'" }} />
                <button onClick={tellJoe} disabled={busy || !editReq.trim()} style={miniBtn(!!editReq.trim())}>{busy ? "…" : "Apply"}</button>
              </div>
              {err && <div style={{ color: CA.red, fontSize: 11.5 }}>{err}</div>}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {(() => {
                  // A future start date means this program isn't meant to run YET —
                  // it schedules into Drafts instead of replacing the live program
                  // (Will: never a future "current" phase). Early apply stays
                  // possible from the Drafts tab, where the diff gate makes the
                  // intent explicit.
                  const st = parseTimeline(blueprint?.timeline?.value).start;
                  const future = st && st > todayStr();
                  return future && saveTarget !== "library" ? (
                    <button onClick={async () => { await park(blueprint, transcript, "draft", draftText); setPhase("scheduled"); }}
                      disabled={busy || !draftText.trim()} style={priBtn}>
                      📅 SCHEDULE FOR {st}
                    </button>
                  ) : saveTarget === "library" ? (
                    <button onClick={saveToProgram} disabled={busy || !draftText.trim()} style={priBtn}>
                      {busy ? "SAVING…" : "SAVE TO MY LIBRARY"}
                    </button>
                  ) : (
                    <button onClick={() => setConfirmSave(lineDiff(athlete.program_text || "", draftText).filter(x => x.type !== "same" || x.text.trim()))}
                      disabled={busy || !draftText.trim()} style={priBtn}>
                      SAVE TO {viewer === "coach" ? "THEIR PROGRAM" : "MY PROGRAM"}
                    </button>
                  );
                })()}
                <button onClick={async () => { await park(blueprint, transcript, "draft", draftText); onParked && onParked(); }} disabled={busy} style={miniBtn(false)}>Send to Drafts</button>
                <button onClick={() => setPhase("interview")} disabled={busy} style={miniBtn(false)}>Back to interview</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Interview view ── */}
      {(phase === "interview" || phase === "boot") && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, gap: 10 }}>
          <div ref={scrollRef} style={{ flex: 1, minHeight: 120, overflowY: "auto", display: "flex", flexDirection: "column", gap: 9, paddingRight: 2 }}>
            {/* T62: Joe's opening question arriving — a bubble taking shape in the
                place it will occupy, not a mono placeholder above empty space. */}
            {phase === "boot" && (
              <div role="status" aria-label="Charging blueprint" style={{ alignSelf: "flex-start", maxWidth: "88%", minWidth: "72%", background: CA.navy3, border: `1px solid ${CA.border}`, borderRadius: 11, padding: "10px 12px" }}>
                <Skeleton lines={[94, 76, 52]} line={10} gap={9} />
              </div>
            )}
            {transcript.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%", background: m.role === "user" ? `${CA.accent}18` : CA.navy3, border: `1px solid ${m.role === "user" ? `${CA.accent}44` : CA.border}`, borderRadius: 11, padding: "8px 12px", color: CA.text, fontSize: 12.5, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                {m.content}
              </div>
            ))}
            {busy && (
              <div style={{ display: "flex", alignItems: "center", gap: 9, color: CA.muted, fontSize: 11, ...mono }}>
                <div className="ld-dots" style={{ transform: "scale(.7)", transformOrigin: "left center" }}><i /><i /><i /></div>
                Joe's thinking…
              </div>
            )}
            {err && <div style={{ color: CA.red, fontSize: 11.5 }}>{err}{transcript.length === 0 && <button onClick={() => openInterview(blueprint, scope)} style={{ ...miniBtn(true), marginLeft: 8 }}>Retry</button>}</div>}
          </div>
          {chips.length > 0 && !busy && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flexShrink: 0 }}>
              {chips.map((c, i) => <button key={i} onClick={() => send(c)} style={miniBtn(true, CA.accent)}>{c}</button>)}
            </div>
          )}
          {prefOffer && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", padding: "2px 0" }}>
              <span style={{ fontSize: 11, color: CA.muted2 }}>Standing setup — {describePref(prefOffer.field, prefOffer.value)}?</span>
              <button style={miniBtn(true, CA.accent)} onClick={async () => {
                const p = prefOffer; setPrefOffer(null);
                try {
                  await sbUpsert("athlete_training_prefs", { athlete_id: athlete.id, [p.field]: p.value, source: "builder", confirmed_at: nowIso(), updated_at: nowIso() }, "athlete_id");
                  setLiftContext(lc => ({ ...lc, prefs: normalizePrefs({ ...(lc.prefs || {}), [p.field]: p.value }) }));
                } catch (_) {}
              }}>Make it standing</button>
              <button style={miniBtn(false)} onClick={() => {
                const p = prefOffer; setPrefOffer(null);
                if (p) sbUpsert("athlete_training_prefs", { athlete_id: athlete.id, signals: clearedSignal(liftContext.prefsRow, p.field, p.value), updated_at: nowIso() }, "athlete_id").catch(() => {});
              }}>Just this block</button>
            </div>
          )}
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") send(); }} disabled={busy || phase === "boot"}
              placeholder="Answer Joe…"
              style={{ flex: 1, background: CA.navy3, border: `1px solid ${CA.border}`, borderRadius: 10, padding: "10px 12px", color: CA.text, fontSize: 13, outline: "none", fontFamily:"'Inter'" }} />
            <button onClick={() => send()} disabled={busy || !input.trim()} style={{ ...miniBtn(!!input.trim()), padding: "8px 14px" }}>Send</button>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
            {pct === 100 && (
              <button onClick={generate} disabled={busy}
                style={{ ...priBtn, padding: "9px 18px", boxShadow: `0 0 14px ${CA_GLOW_SAFE}` }}>
                ⚡ DRAFT IT
              </button>
            )}
            {draftText.trim() && pct === 100 && !busy && (
              <button onClick={() => setPhase("draft")} style={miniBtn(false)}>View draft</button>
            )}
            {pct < 100 && <span style={{ color: CA.muted, fontSize: 10.5 }}>Joe drafts only from a 100% blueprint, {cells.length - filledCount(blueprint || {}, cells)} cell{cells.length - filledCount(blueprint || {}, cells) !== 1 ? "s" : ""} to go.</span>}
            <button onClick={async () => { await park(blueprint, transcript, draftText ? "draft" : "interview", draftText || null); onParked && onParked(); }} disabled={busy || !blueprint || transcript.length === 0}
              style={{ ...miniBtn(false), marginLeft: "auto" }}>
              Save & exit → Drafts
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Glow color for the DRAFT IT button (CA_GLOW lives in App.jsx but isn't in the
// import list above to keep the mirrored-file diff tight — same value).
// REBRAND 2026-08-07: was "rgba(58,123,255,.5)" (the old electric-blue glow). This is a
// hand-copy of App.jsx's CA_GLOW, so it does NOT track the export and has to be updated
// alongside it. Glows are banned by the light brand (inert there); the dark-mode
// freeze (Will, 08-10) restores the original bloom, same as its twin.
const CA_GLOW_SAFE = IS_DARK ? "rgba(58,123,255,.5)" : "transparent";

// ─── EDIT A PROGRAM (Builder sub-mode, Will 07-30) ───────────────────────────
// The other half of the Builder tab: you already HAVE a program, you just want
// to change it. Deliberately NOT an interview — no training age, no equipment,
// no competition dates, no goals. It parses nothing about you; it edits the text
// you paste.
//
// Two ways to change it, same as Quick Log's contract (AI fills, you can always
// take the pen yourself):
//   • hand-edit    — the program box is a live textarea, type in it directly
//   • ask Joe      — describe the change in plain language
//
// The hard rule Will set: Joe must say EXACTLY what it would change BEFORE
// anything changes, then you apply or you don't. So an AI edit never mutates
// the program. It produces a PROPOSAL, and the proposal's line-by-line diff is
// COMPUTED here by lineDiff rather than described by the model, because a model
// summarizing its own edit is exactly the thing that can drift from what it
// actually did. Joe's sentence is flavor; the green/red lines are the truth.
export function ProgramEditPane({ athlete, viewer = "athlete", onSaveToProgram }) {
  const [phase, setPhase] = useState("paste");   // paste | editing
  const [text, setText] = useState("");          // the live program (hand-editable)
  const [paste, setPaste] = useState("");
  const [ask, setAsk] = useState("");
  const [proposal, setProposal] = useState(null); // {text, diff, summary} — never auto-applied
  const [log, setLog] = useState([]);            // [{role:"you"|"joe", content}]
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const mono = { fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace" };
  const subhead = { ...mono, fontSize: 9, letterSpacing: 2, color: CA.muted, textTransform: "uppercase" };
  const miniBtn = (active, color = CA.accent) => ({ background: active ? `${color}20` : "transparent", border: `1px solid ${active ? color : CA.border}`, color: active ? color : CA.muted, borderRadius: 8, padding: "5px 11px", cursor: active ? "pointer" : "not-allowed", fontSize: 11.5, fontWeight: 600, fontFamily:"'Inter'" });
  const priBtn = { background: CA_BTN, color:CA.onAccent, border: "none", borderRadius: 9, padding: "9px 16px", cursor: "pointer", fontSize: 13, fontWeight: 700, ...DISP, letterSpacing: 1 };

  const start = () => {
    const t = paste.trim();
    if (t.length < 20) { setErr("Paste a bit more of the program so there's something to work with."); return; }
    setText(t); setPhase("editing"); setErr("");
    track("program_edit_start", "ai");
  };

  // Ask Joe for a change. Returns a PROPOSAL only. Nothing is written to `text`
  // until the athlete taps Apply, which is the whole point of this mode.
  const propose = async () => {
    const req = ask.trim();
    if (!req || busy) return;
    setBusy(true); setErr("");
    try {
      const sys = `You are editing a training program its owner pasted in. They are NOT being interviewed and you must not ask about goals, training age, equipment, or competition dates. Apply ONLY the change they request, preserve every other line character-for-character, and keep the existing format.

Respond in EXACTLY this shape and nothing else:
SUMMARY: <one plain sentence naming what you changed, specific about days/lifts/numbers>
PROGRAM:
<the complete updated program text>

If the request is genuinely ambiguous about THIS program (for example they say "make day 2 harder" and there are two day 2s), do not guess. Instead respond with only:
QUESTION: <one short question>`;
      const raw = await askClaude(sys, `CURRENT PROGRAM:\n${text}\n\nREQUESTED CHANGE: ${req}`, 4000, [], "claude-sonnet-5", "program_apply_change");

      const q = String(raw || "").match(/^\s*QUESTION:\s*([\s\S]+)$/);
      if (q) {
        setLog(l => [...l, { role: "you", content: req }, { role: "joe", content: q[1].trim() }]);
        setAsk("");
        setBusy(false);
        return;
      }
      const parts = String(raw || "").split(/^PROGRAM:\s*$/m);
      const summary = (parts[0] || "").replace(/^\s*SUMMARY:\s*/i, "").trim();
      const body = parts.length > 1 ? parts.slice(1).join("PROGRAM:\n") : raw;
      const guard = mergeGuard(text, body);
      if (!guard.ok) { setErr(guard.reason || "Couldn't make that change cleanly. Say it more specifically."); setBusy(false); return; }

      const diff = lineDiff(text, guard.text);
      const stats = diffStats(diff);
      if (!stats.added && !stats.removed) {
        setLog(l => [...l, { role: "you", content: req }, { role: "joe", content: "That would not change anything in the program as written. Try naming the day or the lift." }]);
        setAsk(""); setBusy(false); return;
      }
      setLog(l => [...l, { role: "you", content: req }, { role: "joe", content: summary || `Proposed ${stats.added} added and ${stats.removed} removed.` }]);
      setProposal({ text: guard.text, diff, summary, stats });
      setAsk("");
      track("program_edit_proposed", "ai");
    } catch (e) { setErr("Couldn't reach Joe just then. Try again."); }
    setBusy(false);
  };

  const applyProposal = () => {
    if (!proposal) return;
    setText(proposal.text);
    setProposal(null);
    setLog(l => [...l, { role: "joe", content: "Applied. Program updated below." }]);
    track("program_edit_applied", "ai");
  };
  const discardProposal = () => {
    setProposal(null);
    setLog(l => [...l, { role: "joe", content: "Left it alone, nothing changed." }]);
    track("program_edit_discarded", "ai");
  };

  const save = async () => {
    if (saving || !text.trim()) return;
    setSaving(true); setErr("");
    try {
      await onSaveToProgram(text, null);
      track("program_edit_saved", "ai");
      setLog(l => [...l, { role: "joe", content: "Saved. That's your program now." }]);
    } catch (e) { setErr("Couldn't save that. Try again in a sec."); }
    setSaving(false);
  };

  if (phase === "paste") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={subhead}>Edit a program</div>
        <div style={{ color: CA.muted2, fontSize: 12.5, lineHeight: 1.65 }}>
          Already running something? Paste it in and change it here. No questions about your goals or your training history, this just edits what you give it.
        </div>
        <textarea value={paste} onChange={e => setPaste(e.target.value)} rows={12}
          placeholder={"Paste your program here, any format.\n\nDay 1 - Upper\nBench 4x5 @ 185\n..."}
          style={{ width: "100%", boxSizing: "border-box", background: "rgba(58,123,255,0.03)", border: `1px solid ${CA.line2}`, borderRadius: 10, padding: "10px 12px", color: CA.text, fontSize: 12, outline: "none", resize: "vertical", lineHeight: 1.7, ...mono, ...PAPER_GRID }} />
        {err && <div style={{ color: CA.red, fontSize: 12 }}>{err}</div>}
        <button onClick={start} style={{ ...priBtn, opacity: paste.trim().length >= 20 ? 1 : 0.5 }}>Start editing →</button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start" }}>
      {/* YOUR PROGRAM — hand-editable at all times */}
      <div style={{ flex: "1 1 320px", minWidth: 280, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={subhead}>Your program</div>
          <span style={{ ...mono, fontSize: 9, color: CA.muted }}>type to edit directly</span>
        </div>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={18}
          style={{ width: "100%", boxSizing: "border-box", background: "rgba(58,123,255,0.03)", border: `1px solid ${CA.line2}`, borderRadius: 10, padding: "10px 12px", color: CA.text, fontSize: 12, outline: "none", resize: "vertical", lineHeight: 1.7, ...mono, ...PAPER_GRID }} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={save} disabled={saving} style={{ ...priBtn, opacity: saving ? 0.7 : 1 }}>{saving ? "Saving…" : "Save to my program"}</button>
          <button onClick={() => { setPhase("paste"); setText(""); setPaste(""); setLog([]); setProposal(null); setErr(""); }} style={miniBtn(true, CA.muted2)}>Start over</button>
        </div>
      </div>

      {/* JOE — the conversation, and the proposal gate */}
      <div style={{ flex: "1 1 320px", minWidth: 280, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={subhead}>Ask Joe to change it</div>
        <div style={{ background: CA.navy3, border: `1px solid ${CA.border}`, borderRadius: 10, padding: "10px 12px", maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          {!log.length && <div style={{ color: CA.muted, fontSize: 12, lineHeight: 1.6 }}>Tell Joe what to change and it will show you exactly what it would do before anything moves.</div>}
          {log.map((m, i) => (
            <div key={i} style={{ fontSize: 12, lineHeight: 1.6, color: m.role === "you" ? CA.text : CA.cyan }}>
              <span style={{ ...mono, fontSize: 9, letterSpacing: 1, color: CA.muted, marginRight: 6 }}>{m.role === "you" ? "YOU" : "JOE"}</span>
              {m.content}
            </div>
          ))}
        </div>

        {proposal && (
          <div style={{ border: `1px solid ${CA.accent}66`, background: `${CA.accent}0d`, borderRadius: 10, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ ...mono, fontSize: 9, letterSpacing: 2, color: CA.accent, textTransform: "uppercase" }}>
              Proposed change · {proposal.stats.added} added, {proposal.stats.removed} removed
            </div>
            <div style={{ maxHeight: 220, overflowY: "auto", background: IS_DARK ? "rgba(31,42,55,0.18)" : CA.navy2, borderRadius: 8, padding: "8px 10px" }}>
              {proposal.diff.filter(d => d.type !== "same").length === 0
                ? <div style={{ color: CA.muted, fontSize: 11 }}>No line-level differences.</div>
                : proposal.diff.map((d, i) => d.type === "same" ? null : (
                  <div key={i} style={{ ...mono, fontSize: 11, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word", color: d.type === "add" ? CA.green : CA.red }}>
                    {d.type === "add" ? "+ " : "- "}{d.text || " "}
                  </div>
                ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={applyProposal} style={miniBtn(true, CA.green)}>Apply this change</button>
              <button onClick={discardProposal} style={miniBtn(true, CA.muted2)}>Don't apply</button>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 6 }}>
          <input value={ask} onChange={e => setAsk(e.target.value)} onKeyDown={e => { if (e.key === "Enter") propose(); }}
            placeholder={'e.g. "swap day 2 to dumbbells"'}
            style={{ flex: 1, background: CA.navy3, border: `1px solid ${CA.border}`, borderRadius: 9, padding: "8px 11px", color: CA.text, fontSize: 12, outline: "none", fontFamily:"'Inter'" }} />
          <button onClick={propose} disabled={busy || !ask.trim()} style={miniBtn(!busy && !!ask.trim())}>{busy ? "…" : "Ask"}</button>
        </div>
        {err && <div style={{ color: CA.red, fontSize: 12 }}>{err}</div>}
      </div>
    </div>
  );
}
