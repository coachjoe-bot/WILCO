// ─── PROOF FEED ENGINE (Vercel) ──────────────────────────────────────────────
// Generates weekly/monthly athlete digests + weekly/monthly coach reports, writes
// them to proof_digests, and emails them.
//
// HISTORY: the engine used to live in a Supabase edge function that read its DB
// credential from a never-set secret and crashed on every run — the feature never
// produced a digest. It now lives here on Vercel (auto-deploys on push, reads the
// already-set SUPABASE_SERVICE_KEY). All compute + AI generation is in api/_proof.js.
//
// The daily account-deletion sweep (Privacy Policy §4/§5) used to be triggered
// from the end of this handler's cron path (a fetch to a Supabase edge function),
// sharing this route because of the old Hobby 12-function cap. Vercel Pro lifted
// that cap, so it's now its own route + its own cron: see api/process-deletions.js
// and the "/api/process-deletions" entry in vercel.json. This file's behavior is
// otherwise unchanged.
//
// DISPATCH (proof-feed-v3): the pg_cron per-athlete fanout (2 SQL functions +
// pg_cron jobs, see supabase/migrations/20260625_proof_feed_v2_cron.sql) existed
// ONLY because of the old Vercel Hobby 10s duration wall — one invocation could
// never loop the whole roster. Vercel Pro allows up to 300s, so this single Vercel
// cron entry (vercel.json, mirrors the old pg_cron athlete-dispatch cadence) now
// loops every DUE athlete SEQUENTIALLY in one invocation; one athlete's failure is
// caught per-iteration and logged, never aborting the rest. The pg_cron dispatch
// functions + jobs are dropped in supabase/migrations/20260704_drop_proof_feed_cron_fanout.sql
// (NOT applied yet — runs at merge time, see that file's header). The per-id
// (body.athlete_id) and per-coach (body.coach_id) entry modes below are KEPT as
// generic single-target modes (still useful for support/debugging or a future
// re-introduction of fanout at much higher scale) but are no longer load-bearing
// for the daily schedule.
//
// TWO ENTRY MODES (spec §12):
//   1. Scheduler — cron secret header (CRON_SECRET) or Vercel's x-vercel-cron.
//      Sweeps all DUE athletes + generates coach reports, one invocation, in order.
//      Accepts an optional {dry_run:true} (cron-secret-gated ONLY — see below) that
//      runs the full pipeline (compute + Claude generation) and returns the prose
//      WITHOUT writing to proof_digests, advancing cycle state, sending email, or
//      firing a push. Used to pull real-data samples for review before shipping
//      prose changes (docs/proof-feed-v3-samples.md).
//   2. Run-now — POST { auth:{role,id,pin}, run_now:true } from the app. Generates
//      for THAT athlete only (own id), enforcing the once-per-day cap.
//
// FEED-DRIVEN PUSH (proof-feed-v3): once an entry is actually written (never in
// dry-run), the athlete gets ONE push announcing it, capped at once/day via
// athlete_nudge_state.last_feed_push_at (see 20260704_notification_policy_v2.sql).
// This is entirely independent of the inactivity-nudge cooldown in api/push.js —
// different table, different column, never touches each other's state.
//
// Env: ANTHROPIC_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY,
//      FROM_EMAIL, APP_URL (defaults below), CRON_SECRET, VAPID_*.

import { sbSelect, sbInsert, sbWrite, sbDelete, authCaller, httpErr, askClaudeServer } from "./_supa.js";
import {
  groupIntoSessions, aggregateInjuries, buildOneRMs, buildBrief,
  parseProgramIfNeeded, compareProgramVsActual, computeRankMovement, painTrend,
  generateWeekly, generateMonthly, generateCoach, blendAdherenceScore, trueImprovementPRs,
} from "./_proof.js";
import { computeGritSnapshot } from "./_grit.js";
import { sendToAthlete, pushPayload } from "./_push.js";

const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "WILCO <noreply@trainwilco.com>";
const APP_URL = process.env.APP_URL || "https://app.trainwilco.com";

const todayStr = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
const enc = encodeURIComponent;

// ── Generic digest email (renders intro + sections[] + coach actions) ─────────
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const buildDigestEmail = (recipientName, contentJson, label) => {
  const c = contentJson || {};
  const first = String(recipientName || "").split(" ")[0] || "there";
  const sectionHtml = (c.sections || []).map((s) => {
    const color = s.flag === "warn" ? "#e74c3c" : "#d4a017";
    return `<div style="margin:0 0 16px"><h3 style="color:${color};font-size:13px;letter-spacing:1px;margin:0 0 6px">${esc(s.label)}</h3><p style="margin:0;font-size:14px;line-height:1.7;color:#333">${esc(s.body).replace(/\n/g, "<br>")}</p></div>`;
  }).join("\n");
  const actionsHtml = (c.actions || []).length
    ? `<div style="background:#f0fff4;border-left:3px solid #27ae60;padding:12px 14px;margin:8px 0;border-radius:0 6px 6px 0"><strong style="color:#27ae60;font-size:13px">COACH ACTIONS</strong><ul style="margin:8px 0 0;padding-left:18px;font-size:14px;line-height:1.7;color:#333">${c.actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>`
    : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:580px;margin:0 auto;padding:24px 16px">
  <div style="background:#060d1e;border-radius:12px 12px 0 0;padding:24px 28px;text-align:center">
    <div style="font-size:40px;font-weight:900;color:#d4a017;letter-spacing:6px">WILCO</div>
    <div style="color:#64748b;font-size:11px;letter-spacing:4px;margin-top:4px">PROOF FEED</div>
    <div style="color:#94a3b8;font-size:13px;margin-top:8px">${esc(label)}</div>
  </div>
  <div style="background:#fff;padding:28px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0">
    <p style="font-size:16px;margin:0 0 20px;color:#1a1a2e">Hey ${esc(first)},</p>
    ${c.intro ? `<p style="font-size:14px;line-height:1.7;color:#333;margin:0 0 16px">${esc(c.intro)}</p>` : ""}
    ${sectionHtml}
    ${actionsHtml}
    <div style="text-align:center;margin-top:24px">
      <a href="${APP_URL}" style="display:inline-block;background:#d4a017;color:#000;font-weight:700;font-size:13px;letter-spacing:1px;padding:12px 28px;border-radius:8px;text-decoration:none">OPEN IN APP →</a>
    </div>
  </div>
  <div style="background:#060d1e;border-radius:0 0 12px 12px;padding:16px 28px;text-align:center">
    <p style="color:#475569;font-size:11px;margin:0">WILCO · Your proof is in the work.</p>
  </div>
</div></body></html>`;
};

const sendEmail = async (to, subject, html) => {
  if (!RESEND_KEY || !to) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
    });
  } catch (e) { console.error("[proof-feed] email failed:", e.message); }
};

// ── Feed-driven push: one per athlete, capped once/day (proof-feed-v3) ────────
// Independent of the inactivity-nudge cooldown (api/push.js uses athlete_nudge_state
// too, but different columns — stage_14_sent_at/stage_30_sent_at vs this table's
// last_feed_push_at — so the two features can never clobber each other's timers).
async function sendFeedPush(athlete, digest, windowType) {
  try {
    const stateRows = await sbSelect("athlete_nudge_state", `?athlete_id=eq.${enc(athlete.id)}&select=last_feed_push_at`);
    const lastPush = stateRows[0]?.last_feed_push_at;
    if (lastPush && new Date(lastPush).toDateString() === new Date().toDateString()) return; // already pushed today

    const subs = await sbSelect("push_subscriptions", `?athlete_id=eq.${enc(athlete.id)}&select=*`);
    if (subs.length === 0) return;

    // Kept deliberately simple (Will's call): call out new PRs when there are any,
    // otherwise a plain "ready" line. No rank-movement or focus-teaser variants.
    const prSection = digest.contentJson?.sections?.find((s) => s.label === "PRS & PROGRESS");
    let body;
    if (prSection) body = "New PRs are in your Proof Feed. Go check it out.";
    else body = windowType === "monthly" ? "Your monthly recap is ready." : "Your weekly Proof Feed is ready.";

    const payload = pushPayload({ title: "Coach Joe", body, url: "/", type: "feed" });
    await sendToAthlete(subs, payload);

    await sbWrite({
      method: "POST", table: "athlete_nudge_state", query: "?on_conflict=athlete_id",
      body: { athlete_id: athlete.id, last_feed_push_at: new Date().toISOString() },
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  } catch (e) { console.error("[proof-feed] feed push failed:", e.message); }
}

// ── Build one athlete's brief from already-fetched batch data ──────────────────
// `fullWorkouts`/`fullManual` (proof-feed-v3) are the athlete's UNWINDOWED history
// (not just the 28-day batch window) — needed so Grit rank movement reflects PRs
// set at any point, not just this month.
const briefFor = (athlete, batch, windowType, fullWorkouts, fullManual, previousEntryAt) => {
  const w28 = (batch.workouts || []).filter((w) => w.athlete_id === athlete.id);
  const goals = (batch.goals || []).filter((g) => g.athlete_id === athlete.id);
  const prs = (batch.prs || []).filter((p) => p.athlete_id === athlete.id);
  const manual = (batch.manual || []).filter((m) => m.athlete_id === athlete.id);

  const thisWeekCut = new Date(Date.now() - 7 * 864e5).toISOString();
  const lastWeekCut = new Date(Date.now() - 14 * 864e5).toISOString();
  const monthCut = new Date(Date.now() - 28 * 864e5).toISOString();

  const thisWeekSessions = groupIntoSessions(w28.filter((w) => w.created_at >= thisWeekCut));
  const lastWeekSessions = groupIntoSessions(w28.filter((w) => w.created_at >= lastWeekCut && w.created_at < thisWeekCut));
  const monthSessions = groupIntoSessions(windowType === "monthly" ? w28 : w28.filter((w) => w.created_at >= monthCut));

  const oneRMs = buildOneRMs(prs, manual);
  const injuries = aggregateInjuries(
    windowType === "monthly" ? monthSessions : [...lastWeekSessions, ...thisWeekSessions],
    athlete.resolved_pain || []
  );
  // Pain trend needs a real this-week-vs-last-week comparison regardless of window
  // type (the monthly digest still rides the weekly generator's injury section).
  const painTrendData = painTrend(thisWeekSessions, lastWeekSessions, athlete.resolved_pain || []);

  // Grit rank movement: current snapshot vs the athlete's own last feed entry.
  // Skipped (rank stays null) when there's no bodyweight on file — the whole ladder
  // is bodyweight-relative and computeGritSnapshot degrades to all-zero without it,
  // which would read as a false "no lifts ranked" rather than "can't rank yet."
  let rank = null;
  const bodyweightLbs = athlete.weight_lbs || athlete.weight;
  if (bodyweightLbs && (fullWorkouts || fullManual)) {
    try { rank = computeRankMovement(fullWorkouts || [], fullManual || [], athlete, previousEntryAt); }
    catch (e) { console.error("[proof-feed] rank movement failed:", e.message); }
  }

  return {
    thisWeekSessions, lastWeekSessions, monthSessions, prs, oneRMs,
    brief: buildBrief({ athlete, thisWeekSessions, lastWeekSessions, monthSessions, prs, goals, adherence: null, injuries, windowType, rank, painTrendData }),
  };
};

// ── Generate ONE athlete's digest. `dryRun` skips ALL persistence (no proof_digests
// write, no cycle/cap advance, no email, no push) and returns the generated prose
// alongside the normal result shape, for the sample-generation dry-run path. ──────
async function runAthlete(athlete, batch, { dryRun = false } = {}) {
  const cycleCount = athlete.proof_cycle_count || 1;
  const isMonthly = cycleCount === 4;
  const windowType = isMonthly ? "monthly" : "weekly";

  const attribution = {
    role: "athlete", actor_id: athlete.id, athlete_id: athlete.id,
    school_id: athlete.school_id ?? null, coach_id: athlete.coach_id ?? null, tier: athlete.tier ?? null,
  };
  const deps = { askClaudeServer, sbWrite, sbSelect, attribution };

  // Full (unwindowed) history for Grit rank movement — bounded to the last 300
  // workouts so an old, very active athlete's history can't blow up the request.
  // The client's own Progress screen caps similarly (limit=100 on the read); 300
  // gives the rank snapshot more runway server-side without being unbounded.
  let fullWorkouts = [], fullManual = [];
  try {
    [fullWorkouts, fullManual] = await Promise.all([
      sbSelect("workouts", `?athlete_id=eq.${enc(athlete.id)}&select=created_at,parsed_data&order=created_at.desc&limit=300`),
      sbSelect("manual_one_rms", `?athlete_id=eq.${enc(athlete.id)}&select=exercise,normalized_exercise,weight,unit`),
    ]);
  } catch (e) { console.error("[proof-feed] full-history fetch failed:", e.message); }

  // Find this athlete's most recent PRIOR entry (before today) to diff rank against.
  let previousEntryAt = null;
  try {
    const prior = await sbSelect("proof_digests", `?athlete_id=eq.${enc(athlete.id)}&digest_type=in.(weekly,monthly)&select=created_at&order=created_at.desc&limit=1`);
    previousEntryAt = prior[0]?.created_at || null;
  } catch (e) { console.error("[proof-feed] prior-entry lookup failed:", e.message); }

  const b = briefFor(athlete, batch, windowType, fullWorkouts, fullManual, previousEntryAt);

  // Phase 2: structured program parse (hash-guarded; free if unchanged), then the
  // code-only load+volume adherence comparison.
  const existingRx = (batch.prescriptions || []).find((p) => p.athlete_id === athlete.id) || null;
  try {
    // Dry-run must never write a program_prescriptions cache row from sample
    // generation — parseProgramIfNeeded only writes when the hash changed, and
    // sample runs don't touch prod program_text, so this is naturally a no-op in
    // practice; the explicit dryRun deps guard below is defense in depth.
    const parsed = athlete.temp_program_text ? null : await parseProgramIfNeeded(athlete, existingRx, dryRun ? { ...deps, sbWrite: async () => {} } : deps);
    if (parsed) b.brief.volume = compareProgramVsActual(parsed, b.thisWeekSessions, b.oneRMs);
  } catch (e) { console.error("[proof-feed] program parse failed:", e.message); }

  const digest = isMonthly ? await generateMonthly(athlete, b.brief, deps) : await generateWeekly(athlete, b.brief, deps);

  if (dryRun) {
    return { athlete: athlete.name, athlete_id: athlete.id, type: windowType, digest, brief: b.brief };
  }

  // Replace any prior weekly/monthly digest for this athlete.
  await sbDelete("proof_digests", `?athlete_id=eq.${athlete.id}&digest_type=in.(weekly,monthly)`);
  await sbInsert("proof_digests", {
    athlete_id: athlete.id,
    coach_id: athlete.coach_id || null,
    digest_type: isMonthly ? "monthly" : "weekly",
    label: digest.label,
    content_json: digest.contentJson,
    is_read: false,
    has_plateau: digest.has_plateau,
    has_pain: digest.has_pain,
    has_missed: digest.has_missed,
  });

  // Advance cycle (1,2,3 weekly; 4 monthly → reset to 1), stamp send + daily cap.
  await sbWrite({
    method: "PATCH", table: "athletes", query: `?id=eq.${athlete.id}`, prefer: "return=minimal",
    body: {
      proof_cycle_count: isMonthly ? 1 : Math.min(cycleCount + 1, 4),
      last_proof_sent_at: new Date().toISOString(),
      last_proof_run_date: todayStr(),
      next_proof_due_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    },
  });

  if (athlete.email) {
    const subject = isMonthly
      ? `Your WILCO Monthly Recap — ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}`
      : `Your WILCO Weekly — Week of ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" })}`;
    await sendEmail(athlete.email, subject, buildDigestEmail(athlete.name, digest.contentJson, digest.label));
  }

  // Feed-driven push (proof-feed-v3) — best-effort, capped 1/day, never blocks the result.
  await sendFeedPush(athlete, digest, windowType);

  return { athlete: athlete.name, type: windowType };
}

// ── Generate + persist coach reports (team aggregate per coach) ────────────────
// Bounded by total roster; loops in the same single invocation as the athlete sweep.
// Enrich one athlete for the coach team brief: their per-athlete brief + program
// adherence (needs the parsed prescription) + Grit snapshot + blended score.
const enrichForCoach = (a, batch) => {
  const bf = briefFor(a, batch, "weekly");
  const parsed = (batch.prescriptions || []).find((p) => p.athlete_id === a.id)?.parsed_json || null;
  const adherence = parsed ? compareProgramVsActual(parsed, bf.thisWeekSessions, bf.oneRMs) : null;
  const wo = (batch.workouts || []).filter((w) => w.athlete_id === a.id);
  const man = (batch.manual || []).filter((m) => m.athlete_id === a.id);
  let snap = { rankedLifts: [] };
  try { snap = computeGritSnapshot(wo, man, { bodyweightLbs: a.weight_lbs || a.weight || 0, gender: a.gender, age: a.age }); } catch { /* no bodyweight → no tiers */ }
  const hasProgram = !!(a.program_text && a.program_text.trim().length > 10);
  const presDays = a.training_days_per_week || parsed?.blocks?.[0]?.days?.length || null;
  const score = blendAdherenceScore(bf.thisWeekSessions.length, adherence, hasProgram, presDays);
  // True PRs (improvement over prior best) in the reporting window — honest counts,
  // baselines excluded, ahead of the is_baseline persistence.
  const weekCut = Date.now() - 7 * 864e5;
  const truePRs = trueImprovementPRs(bf.prs).filter((p) => new Date(p.created_at || p.date || 0).getTime() >= weekCut);
  return { athlete: a, brief: bf.brief, adherence, snap, score, hasProgram, prs: bf.prs, truePRs };
};

// ISO week number — used only to pick the monthly-coach cadence (every 4th week).
const isoWeek = (d) => {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 864e5 + 1) / 7);
};

async function runCoachReports(allAthletes, batch, coaches) {
  const results = [];
  const byCoach = {};
  for (const a of allAthletes) {
    if (!a.coach_id) continue;
    (byCoach[a.coach_id] = byCoach[a.coach_id] || []).push(a);
  }
  // Monthly cadence mirrors the athlete 4-week cycle: every 4th ISO week the coach
  // gets the deeper MONTHLY edition instead of the weekly (tunable; no per-coach
  // state). monthly_coach was coded but never fired before this.
  const type = isoWeek(new Date()) % 4 === 0 ? "monthly_coach" : "weekly_coach";

  for (const [coachId, roster] of Object.entries(byCoach)) {
    const coach = (coaches || []).find((c) => c.id === coachId);
    if (!coach) continue;
    try {
      const perAthlete = roster.map((a) => enrichForCoach(a, batch));
      // Prior context the coach gave us (season/goals/fatigue/notes) → written into
      // the edition so it advises against the real situation. Defensive: the table
      // may not exist yet on older environments.
      let coachContext = "";
      try {
        const ctxRows = await sbSelect("coach_context", `?coach_id=eq.${enc(coach.id)}&select=note&order=created_at.desc&limit=8`);
        if (Array.isArray(ctxRows) && ctxRows.length) coachContext = ctxRows.map((r) => r.note).filter(Boolean).join("\n");
      } catch { /* no coach_context table/rows — fine */ }

      const attribution = { role: "coach", actor_id: coach.id, coach_id: coach.id, school_id: coach.school_id ?? null };
      const report = await generateCoach(coach, perAthlete, { askClaudeServer, attribution, coachContext }, type);
      await sbDelete("proof_digests", `?coach_id=eq.${coach.id}&digest_type=eq.${type}`);
      await sbInsert("proof_digests", {
        athlete_id: null, coach_id: coach.id, digest_type: type,
        label: report.label, content_json: report.contentJson, is_read: false,
        has_plateau: false, has_pain: report.has_pain, has_missed: report.has_missed,
      });
      if (coach.email) await sendEmail(coach.email, `WILCO Coach's Edition — Week of ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" })}`, buildDigestEmail(coach.name || "Coach", report.contentJson, report.label));
      results.push({ coach: coach.name, athletes: roster.length, type });
    } catch (e) { console.error(`[proof-feed] coach report failed for ${coachId}:`, e.message); results.push({ coach: coachId, ok: false, error: e.message }); }
  }
  return results;
}

// ── Batch-fetch everything the briefs need for a set of athlete ids ───────────
async function fetchBatch(ids) {
  if (!ids.length) return { workouts: [], goals: [], prs: [], manual: [], prescriptions: [] };
  const idList = ids.map((id) => `"${id}"`).join(",");
  const since = new Date(Date.now() - 28 * 864e5).toISOString();
  const [workouts, goals, prs, manual, prescriptions] = await Promise.all([
    sbSelect("workouts", `?athlete_id=in.(${idList})&created_at=gte.${since}&select=*&order=created_at.asc`),
    sbSelect("athlete_goals", `?athlete_id=in.(${idList})&select=*&order=created_at.desc`),
    sbSelect("prs", `?athlete_id=in.(${idList})&select=*`),
    sbSelect("manual_one_rms", `?athlete_id=in.(${idList})&select=*`),
    // program_prescriptions only exists after the Phase 1 migration — tolerate its
    // absence so deploying code before the migration can't hard-fail the run.
    sbSelect("program_prescriptions", `?athlete_id=in.(${idList})&select=*`).catch(() => []),
  ]);
  return { workouts, goals, prs, manual, prescriptions };
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
// Vercel Pro: cap this function's execution time. proof-feed-v3 makes the daily
// scheduler sweep the PRIMARY dispatch path (was a bounded per-id fanout target
// under the old Hobby 10s wall) — 300s (Vercel's own ceiling) gives one invocation
// room to loop the whole roster sequentially, each athlete a Claude call + a few
// DB round-trips.
export const maxDuration = 300;

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL) return res.status(500).json({ error: "Missing SUPABASE_URL" });
  if (!SERVICE_KEY) return res.status(500).json({ error: "Missing SUPABASE_SERVICE_KEY — add it in Vercel → Settings → Environment Variables" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // Auth: run-now (authenticated athlete) OR scheduler (cron secret ONLY).
  // The scheduler path drives the full roster sweep + arbitrary-id fanout (mass AI
  // spend + mass email), so it must be gated by a real secret. We authenticate it
  // SOLELY via the Authorization: Bearer <CRON_SECRET> that Vercel injects into cron
  // invocations when CRON_SECRET is set — NOT the x-vercel-cron header (which an
  // external caller can forge) and NOT a "secret unset → open" fail-open.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return res.status(500).json({ error: "Missing CRON_SECRET" });
  const isCron = req.headers["authorization"] === `Bearer ${cronSecret}`;
  // Dry-run (proof-feed-v3 sample generation): ONLY honored on the cron-secret path
  // (never for an athlete's own run-now) — it's for pulling review samples, not a
  // user-facing feature, and skipping it for run-now keeps that path's daily-cap
  // semantics exactly as before (a real run-now always counts against the cap).
  const dryRun = isCron && body.dry_run === true;
  let runNowAthleteId = null;
  if (!isCron) {
    try {
      const caller = await authCaller(body.auth);          // verifies PIN server-side
      if (caller.role !== "athlete") throw httpErr(403, "Only athletes can run their own Proof Feed");
      runNowAthleteId = caller.id;                          // own id ONLY — can't run for others
    } catch (e) {
      return res.status(e.status || 401).json({ error: e.message || "Unauthorized" });
    }
  }

  try {
    const results = { athletes: [], coaches: [], skipped: [] };

    if (runNowAthleteId) {
      // ── Run-now: this athlete only, daily-cap enforced ──
      const rows = await sbSelect("athletes", `?id=eq.${runNowAthleteId}&select=*`);
      const athlete = rows[0];
      if (!athlete) return res.status(404).json({ error: "Athlete not found" });
      if (athlete.proof_enabled === false) return res.status(200).json({ ok: false, reason: "Proof Feed is turned off in settings." });
      if (athlete.last_proof_run_date === todayStr()) {
        return res.status(200).json({ ok: false, reason: "You've already generated today's Proof Feed. Come back tomorrow." });
      }
      const batch = await fetchBatch([athlete.id]);
      results.athletes.push(await runAthlete(athlete, batch));
      return res.status(200).json({ ok: true, ...results });
    }

    // ── Dry-run sample pull: specific athlete ids, full pipeline, zero writes ──
    if (dryRun && Array.isArray(body.sample_athlete_ids) && body.sample_athlete_ids.length) {
      const ids = body.sample_athlete_ids.map(String);
      const rows = await sbSelect("athletes", `?id=in.(${ids.map((id) => `"${id}"`).join(",")})&select=*`);
      const batch = await fetchBatch(rows.map((a) => a.id));
      const samples = [];
      for (const athlete of rows) {
        try { samples.push(await runAthlete(athlete, batch, { dryRun: true })); }
        catch (e) { samples.push({ athlete: athlete.name, athlete_id: athlete.id, error: e.message }); }
      }
      return res.status(200).json({ ok: true, dry_run: true, samples });
    }

    // ── Single-target modes (id/coach) — generic utility entries, not the daily
    //    schedule (kept for support/debugging; see file header). ──
    if (body.athlete_id) {
      const rows = await sbSelect("athletes", `?id=eq.${encodeURIComponent(body.athlete_id)}&select=*`);
      const athlete = rows[0];
      if (!athlete) return res.status(404).json({ error: "Athlete not found" });
      if (!dryRun && (athlete.proof_enabled === false || athlete.last_proof_run_date === todayStr())) {
        return res.status(200).json({ ok: false, skipped: true });
      }
      const batch = await fetchBatch([athlete.id]);
      return res.status(200).json({ ok: true, dry_run: dryRun, athlete: await runAthlete(athlete, batch, { dryRun }) });
    }
    if (body.coach_id) {
      const roster = await sbSelect("athletes", `?coach_id=eq.${encodeURIComponent(body.coach_id)}&select=*`);
      const rosterBatch = await fetchBatch(roster.map((a) => a.id));
      const coaches = await sbSelect("coaches", `?id=eq.${encodeURIComponent(body.coach_id)}&select=id,name,email,school_id`);
      const coaches2 = await runCoachReports(roster, rosterBatch, coaches);
      return res.status(200).json({ ok: true, coaches: coaches2 });
    }

    // ── Scheduler sweep — the PRIMARY dispatch path (proof-feed-v3). One Vercel
    //    cron invocation (vercel.json) loops every due athlete sequentially, in
    //    order, logging each outcome; one athlete's failure never aborts the rest. ──
    const now = new Date().toISOString();
    const due = await sbSelect("athletes", `?next_proof_due_at=lte.${now}&select=*&order=created_at.asc`);

    // Bootstrap: never-run athletes with a session ≥7 days old.
    const neverRun = await sbSelect("athletes", `?next_proof_due_at=is.null&select=*`);
    let bootstrap = [];
    if (neverRun.length) {
      const ids = neverRun.map((a) => `"${a.id}"`).join(",");
      const sevenAgo = new Date(Date.now() - 7 * 864e5).toISOString();
      const old = await sbSelect("workouts", `?athlete_id=in.(${ids})&created_at=lte.${sevenAgo}&select=athlete_id`);
      const has = new Set(old.map((s) => s.athlete_id));
      bootstrap = neverRun.filter((a) => has.has(a.id));
    }

    const allDue = [...due, ...bootstrap.filter((a) => !due.find((d) => d.id === a.id))]
      .filter((a) => a.proof_enabled !== false && a.last_proof_run_date !== todayStr());

    const batch = await fetchBatch(allDue.map((a) => a.id));
    for (const athlete of allDue) {
      try {
        const outcome = await runAthlete(athlete, batch);
        results.athletes.push(outcome);
        console.log(`[proof-feed] ok: ${athlete.name} (${athlete.id}) — ${outcome.type}`);
      } catch (e) {
        results.skipped.push({ athlete: athlete.name, error: e.message });
        console.error(`[proof-feed] FAILED: ${athlete.name} (${athlete.id}) — ${e.message}`);
      }
    }

    // Coach reports — aggregate over each coach's full roster.
    const coachIds = [...new Set(allDue.map((a) => a.coach_id).filter(Boolean))];
    if (coachIds.length) {
      const rosterIdList = coachIds.map((id) => `"${id}"`).join(",");
      const roster = await sbSelect("athletes", `?coach_id=in.(${rosterIdList})&select=*`);
      const rosterBatch = await fetchBatch(roster.map((a) => a.id));
      const coaches = await sbSelect("coaches", `?select=id,name,email,school_id`);
      results.coaches = await runCoachReports(roster, rosterBatch, coaches);
    }

    console.log(`[proof-feed] sweep complete: ${results.athletes.length} ok, ${results.skipped.length} failed, ${results.coaches.length} coach reports`);
    return res.status(200).json({ processed: results.athletes.length, ...results });
  } catch (err) {
    console.error("[proof-feed] fatal:", err);
    return res.status(500).json({ error: err.message });
  }
}
