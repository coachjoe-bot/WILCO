// ─── PROOF FEED ENGINE (Vercel) ──────────────────────────────────────────────
// Generates weekly/monthly Proof Feed digests in-process and emails them.
//
// HISTORY: the digest engine used to live in a Supabase EDGE function
// (supabase/functions/proof-feed-daily). That function read its DB credential
// from Deno.env.get("SERVICE_KEY") — a secret that was never set — so every call
// 401'd and the job crashed on its first .map(); it never produced a single
// digest. v2 Phase 0 moves the engine HERE, onto Vercel, which deploys
// automatically on `git push` and reads SUPABASE_SERVICE_KEY (already set). The
// edge function is deleted; this file is now the engine.
//
// Triggered by the daily Vercel Cron (see vercel.json), or manually with the
// cron secret. It still ALSO triggers the separate process-deletions edge
// function (Privacy Policy §4/§5) — that one stays on Supabase.
//
// WHY IT LIVES WITH process-deletions: Vercel Hobby caps a deployment at 12
// Serverless Functions and the project is at that limit, so we add NO new
// function — the engine and the deletions trigger share this one route. (Shared
// helpers in _supa.js are `_`-prefixed and don't count as functions.)
//
// Required Vercel env vars (all already set except APP_URL, which has a default):
//   ANTHROPIC_KEY        — Anthropic API key
//   SUPABASE_URL / VITE_SUPABASE_URL — project URL
//   SUPABASE_SERVICE_KEY — service role key (full DB access, bypasses RLS)
//   RESEND_API_KEY       — Resend email API key
//   FROM_EMAIL           — sender, e.g. "WILCO <noreply@trainwilco.com>"
//   APP_URL              — public app URL (defaults to https://app.trainwilco.com)
//   CRON_SECRET          — shared secret for manual triggers

import { sbSelect, sbInsert, sbWrite, sbDelete, askClaudeServer } from "./_supa.js";

const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "WILCO <noreply@trainwilco.com>";
const APP_URL = process.env.APP_URL || "https://app.trainwilco.com";

// ── Workout helpers ───────────────────────────────────────────────────────────
const getPD = (w) => {
  if (typeof w.parsed_data === "string") {
    try { return JSON.parse(w.parsed_data); } catch { return {}; }
  }
  return w.parsed_data || {};
};

const isRealSession = (w) => {
  const pd = getPD(w);
  return pd.exercises?.length > 0 || !!pd.run_data;
};

const GAP_MS = 3 * 60 * 60 * 1000;
const groupIntoSessions = (workouts) => {
  const real = workouts.filter(isRealSession)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const groups = [];
  let cur = null, lastTime = 0;
  real.forEach((w) => {
    const t = new Date(w.created_at).getTime();
    const pd = getPD(w);
    if (!lastTime || pd.new_session === true || t - lastTime > GAP_MS) {
      cur = [w]; groups.push(cur);
    } else {
      cur.push(w);
    }
    lastTime = t;
  });
  return groups;
};

const epley1RM = (weight, reps) => {
  if (!weight || weight <= 0) return 0;
  if (!reps || reps <= 1) return weight;
  return Math.round(weight * (1 + reps / 30));
};

// ── Format session for AI context ─────────────────────────────────────────────
const formatSessionForAI = (group) => {
  const date = new Date(group[0].created_at).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
  const exercises = group.flatMap((e) => getPD(e).exercises || []);
  const runData = group.map((e) => getPD(e).run_data).find(Boolean);
  const painFlags = group.flatMap((e) => getPD(e).pain_flags || []);
  const feel = group.map((e) => getPD(e).session_feel).find(Boolean);

  if (runData) {
    const parts = [
      runData.run_type || "run",
      runData.distance_miles ? `${runData.distance_miles}mi` : runData.distance_km ? `${runData.distance_km}km` : "",
      runData.pace_per_mile ? `@${runData.pace_per_mile}/mi` : runData.pace_per_km ? `@${runData.pace_per_km}/km` : "",
      runData.duration_minutes ? `${runData.duration_minutes}min` : "",
    ].filter(Boolean);
    return `${date}: RUN — ${parts.join(" ")}${feel ? ` (${feel})` : ""}${painFlags.length ? ` | PAIN: ${painFlags.map((p) => p.area).join(", ")}` : ""}`;
  }

  const exStr = exercises.map((e) =>
    `${e.name}${e.weight ? ` ${e.weight}${e.unit === "kg" ? "kg" : "lbs"}` : ""}${e.sets && e.reps ? ` ${e.sets}x${e.reps}` : ""}${e.feel ? ` (${e.feel})` : ""}`
  ).join(", ");
  return `${date}: ${exStr || "general training"}${feel ? ` | feel: ${feel}` : ""}${painFlags.length ? ` | PAIN: ${painFlags.map((p) => p.area).join(", ")}` : ""}`;
};

// ── Compute per-lift 1RM history ──────────────────────────────────────────────
const buildLiftHistory = (sessions) => {
  // Returns { liftName: [{date, e1rm, weight, reps}] }
  const byLift = {};
  for (const group of sessions) {
    const date = group[0].created_at;
    const exercises = group.flatMap((e) => getPD(e).exercises || []);
    for (const ex of exercises) {
      if (!ex.name || !ex.weight || ex.unit === "bodyweight") continue;
      const w = ex.unit === "kg" ? ex.weight * 2.205 : ex.weight;
      const e1rm = epley1RM(w, ex.reps || 1);
      const k = ex.name.toLowerCase().trim();
      if (!byLift[k]) byLift[k] = [];
      byLift[k].push({ date, e1rm, weight: ex.weight, reps: ex.reps || 1 });
    }
  }
  return byLift;
};

// ── Plateau detection ─────────────────────────────────────────────────────────
// Returns list of lift names flagged as plateaued (3+ consecutive sessions, ±2.5 lbs tolerance)
const detectPlateaus = (liftHistory) => {
  const flagged = [];
  for (const [lift, entries] of Object.entries(liftHistory)) {
    if (entries.length < 3) continue;
    const last3 = entries.slice(-3);
    const e1rms = last3.map((e) => e.e1rm);
    const max = Math.max(...e1rms), min = Math.min(...e1rms);
    if (max - min <= 2.5) flagged.push(lift);
  }
  return flagged;
};

// ── Email: athlete weekly digest ──────────────────────────────────────────────
const buildAthleteDigestEmail = (athlete, contentJson, label) => {
  const c = contentJson;
  const firstName = athlete.name.split(" ")[0];
  const sections = [
    c.week_vs_week ? `<h3 style="color:#d4a017;font-size:14px;letter-spacing:1px;margin:0 0 8px">THIS WEEK vs LAST WEEK</h3><p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#333">${c.week_vs_week.replace(/\n/g, "<br>")}</p>` : "",
    c.consistency ? `<h3 style="color:#d4a017;font-size:14px;letter-spacing:1px;margin:0 0 8px">CONSISTENCY</h3><p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#333">${c.consistency}</p>` : "",
    c.workouts_logged ? `<h3 style="color:#d4a017;font-size:14px;letter-spacing:1px;margin:0 0 8px">WORKOUTS LOGGED</h3><p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#333">${c.workouts_logged}</p>` : "",
    c.trend_callouts ? `<h3 style="color:#d4a017;font-size:14px;letter-spacing:1px;margin:0 0 8px">TREND CALLOUTS</h3><p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#333">${c.trend_callouts.replace(/\n/g, "<br>")}</p>` : "",
    c.plateau_flag ? `<div style="background:#fff5f5;border-left:3px solid #e74c3c;padding:10px 14px;margin:0 0 16px;border-radius:0 6px 6px 0"><strong style="color:#c0392b">⚠ PLATEAU FLAG:</strong><span style="font-size:14px;color:#333"> ${c.plateau_flag}</span></div>` : "",
    c.encouragement ? `<h3 style="color:#d4a017;font-size:14px;letter-spacing:1px;margin:0 0 8px">FROM COACH JOE</h3><p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#333">${c.encouragement}</p>` : "",
    c.focus_next_week ? `<h3 style="color:#d4a017;font-size:14px;letter-spacing:1px;margin:0 0 8px">FOCUS NEXT WEEK</h3><p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#333">${c.focus_next_week}</p>` : "",
  ].filter(Boolean).join("\n");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:580px;margin:0 auto;padding:24px 16px">
  <div style="background:#060d1e;border-radius:12px 12px 0 0;padding:24px 28px;text-align:center">
    <div style="font-size:40px;font-weight:900;color:#d4a017;letter-spacing:6px">WILCO</div>
    <div style="color:#64748b;font-size:11px;letter-spacing:4px;margin-top:4px">PROOF FEED</div>
    <div style="color:#94a3b8;font-size:13px;margin-top:8px">${label}</div>
  </div>
  <div style="background:#fff;padding:28px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0">
    <p style="font-size:16px;margin:0 0 20px;color:#1a1a2e">Hey ${firstName},</p>
    ${sections}
    <div style="text-align:center;margin-top:24px">
      <a href="${APP_URL}" style="display:inline-block;background:#d4a017;color:#000;font-weight:700;font-size:13px;letter-spacing:1px;padding:12px 28px;border-radius:8px;text-decoration:none">VIEW IN APP →</a>
    </div>
  </div>
  <div style="background:#060d1e;border-radius:0 0 12px 12px;padding:16px 28px;text-align:center">
    <p style="color:#475569;font-size:11px;margin:0">WILCO · Your proof is in the work.</p>
  </div>
</div></body></html>`;
};

// ── Email: monthly coach report ───────────────────────────────────────────────
const buildCoachMonthlyEmail = (coach, athlete, contentJson, label) => {
  const c = contentJson;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:580px;margin:0 auto;padding:24px 16px">
  <div style="background:#060d1e;border-radius:12px 12px 0 0;padding:24px 28px;text-align:center">
    <div style="font-size:40px;font-weight:900;color:#d4a017;letter-spacing:6px">WILCO</div>
    <div style="color:#64748b;font-size:11px;letter-spacing:4px;margin-top:4px">MONTHLY COACH REPORT</div>
  </div>
  <div style="background:#fff;padding:28px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0">
    <p style="font-size:16px;margin:0 0 8px;color:#1a1a2e">Hi ${coach.name || "Coach"},</p>
    <p style="font-size:14px;color:#555;margin:0 0 20px">Here is ${athlete.name}'s monthly summary for ${label}.</p>
    ${c.coach_summary ? `<div style="background:#f8f8f8;border-radius:8px;padding:16px;font-size:14px;line-height:1.7;color:#333">${c.coach_summary.replace(/\n/g, "<br>")}</div>` : ""}
    ${c.flags?.length ? `<div style="background:#fff5f5;border-left:3px solid #e74c3c;padding:10px 14px;margin:16px 0;border-radius:0 6px 6px 0"><strong style="color:#c0392b">Flags:</strong> ${c.flags.join(", ")}</div>` : ""}
    ${c.program_changes ? `<div style="background:#f0fff4;border-left:3px solid #27ae60;padding:10px 14px;margin:16px 0;border-radius:0 6px 6px 0"><strong style="color:#27ae60">Program changes made:</strong> ${c.program_changes}</div>` : ""}
  </div>
  <div style="background:#060d1e;border-radius:0 0 12px 12px;padding:16px;text-align:center">
    <p style="color:#475569;font-size:11px;margin:0">View full recap in the WILCO dashboard.</p>
  </div>
</div></body></html>`;
};

// ── Send Resend email helper ──────────────────────────────────────────────────
const sendEmail = async (to, subject, html) => {
  if (!RESEND_KEY || !to) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
    });
  } catch (e) {
    console.error("[proof-feed] email failed:", e.message);
  }
};

// ── GENERATE WEEKLY DIGEST ────────────────────────────────────────────────────
const generateWeeklyDigest = async (athlete, thisWeekSessions, lastWeekSessions, allMonthSessions) => {
  const now = new Date();
  const weekLabel = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const thisWeekCount = thisWeekSessions.length;
  const lastWeekCount = lastWeekSessions.length;
  const thisMonthCount = allMonthSessions.length;

  const thisWeekLifts = buildLiftHistory(thisWeekSessions);
  const lastWeekLifts = buildLiftHistory(lastWeekSessions);

  const liftLines = [];
  for (const [lift, entries] of Object.entries(thisWeekLifts)) {
    const best = entries.reduce((a, b) => b.e1rm > a.e1rm ? b : a);
    const lastWeek = lastWeekLifts[lift];
    if (lastWeek) {
      const lastBest = lastWeek.reduce((a, b) => b.e1rm > a.e1rm ? b : a);
      const diff = best.e1rm - lastBest.e1rm;
      const dir = diff > 0 ? `+${Math.round(diff)} lbs` : diff < 0 ? `${Math.round(diff)} lbs` : "no change";
      const color = diff > 0 ? "↑" : diff < 0 ? "↓" : "→";
      liftLines.push(`${lift}: ${best.weight} lbs (est. 1RM ${best.e1rm}) ${color} ${dir} from last week`);
    } else {
      liftLines.push(`${lift}: ${best.weight} lbs (est. 1RM ${best.e1rm}) — new this week`);
    }
  }

  const allLiftHistory = buildLiftHistory([...lastWeekSessions, ...thisWeekSessions]);
  const plateaus = detectPlateaus(allLiftHistory);

  const painAreas = thisWeekSessions.flatMap(g =>
    g.flatMap((e) => getPD(e).pain_flags || []).map((p) => p.area)
  );

  const thisWeekFormatted = thisWeekSessions.map(formatSessionForAI).join("\n");
  const lastWeekFormatted = lastWeekSessions.map(formatSessionForAI).join("\n") || "No sessions logged last week.";

  const system = `You are Coach Joe Thomas — high school strength and conditioning coach, 20+ years military background. Direct, specific, no fluff. You are generating a weekly Proof Feed digest for an athlete. Write in Coach Joe's voice throughout. Return a JSON object with these exact keys: week_vs_week, consistency, workouts_logged, trend_callouts, plateau_flag, encouragement, focus_next_week. All values are strings. If a section has nothing meaningful to say (e.g. no trend data, no plateau), set that key to null.

RULES:
- week_vs_week: list each lift logged this week with weight vs last week. Use the data provided — do not invent numbers.
- consistency: "X of Y sessions completed" style. If no programmed sessions, compare to last week count.
- workouts_logged: "You logged X sessions this week and Y this month." Raw count only, no streak language.
- trend_callouts: 1-2 non-obvious patterns only. Leave null if insufficient data. Examples: time-of-day patterns, RPE trends, missed lift clusters, recovery effects.
- plateau_flag: only if clear data supports it. Format: "Your [lift] hasn't moved in X sessions — we'll address this." Leave null if no plateau.
- encouragement: 2-3 sentences in Coach Joe's voice. Specific to this athlete's actual week.
- focus_next_week: one specific directive. Not motivational filler.

Return ONLY valid JSON, no markdown.`;

  const user = `Athlete: ${athlete.name}, Sport: ${athlete.sport}
Goal: ${athlete.goal || "strength"}

THIS WEEK (${thisWeekCount} sessions):
${thisWeekFormatted || "No sessions logged this week."}

LAST WEEK (${lastWeekCount} sessions):
${lastWeekFormatted}

LIFT COMPARISON:
${liftLines.length ? liftLines.join("\n") : "No comparable lift data."}

THIS MONTH TOTAL SESSIONS: ${thisMonthCount}
THIS WEEK TOTAL SESSIONS: ${thisWeekCount}
PAIN FLAGS THIS WEEK: ${painAreas.length ? painAreas.join(", ") : "None"}
PLATEAUS DETECTED: ${plateaus.length ? plateaus.join(", ") : "None"}`;

  const raw = await askClaudeServer({
    system, user, maxTokens: 1200, feature: "proof_weekly",
    attribution: {
      role: "athlete", actor_id: athlete.id, athlete_id: athlete.id,
      school_id: athlete.school_id ?? null, coach_id: athlete.coach_id ?? null, tier: athlete.tier ?? null,
    },
  });

  let contentJson;
  try {
    contentJson = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    contentJson = {
      week_vs_week: thisWeekCount > 0 ? thisWeekFormatted : null,
      consistency: `${thisWeekCount} session${thisWeekCount !== 1 ? "s" : ""} logged this week.`,
      workouts_logged: `You logged ${thisWeekCount} session${thisWeekCount !== 1 ? "s" : ""} this week and ${thisMonthCount} this month.`,
      trend_callouts: null,
      plateau_flag: plateaus.length ? `${plateaus[0]} hasn't shown progress in 3 consecutive sessions — we'll address this.` : null,
      encouragement: "Keep showing up. The work compounds.",
      focus_next_week: "Consistency. Show up for every scheduled session this week.",
    };
  }

  return {
    contentJson,
    label: `WEEKLY DIGEST — ${weekLabel}`,
    has_plateau: !!contentJson.plateau_flag,
    has_pain: painAreas.length > 0,
    has_missed: thisWeekCount === 0,
  };
};

// ── GENERATE MONTHLY RECAP (REPORT PHASE) ────────────────────────────────────
const generateMonthlyRecap = async (athlete, monthSessions, athleteGoals) => {
  const now = new Date();
  const monthLabel = now.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const liftHistory = buildLiftHistory(monthSessions);
  const plateaus = detectPlateaus(liftHistory);
  const painAreas = monthSessions.flatMap(g =>
    g.flatMap((e) => getPD(e).pain_flags || []).map((p) => p.area)
  );
  const sessionCount = monthSessions.length;
  const sessionsFormatted = monthSessions.map(formatSessionForAI).join("\n");
  const goalText = athleteGoals?.map((g) => g.goal_text).filter(Boolean).slice(0, 3).join(" | ") || "No specific goals on file";

  const system = `You are Coach Joe Thomas — high school strength and conditioning coach, 20+ years military background. You are generating the opening report for a Monthly Recap session. This is the start of a conversation — you will deliver the report, then ask reflection questions one at a time. Write only the report for now. Return a JSON object with these keys: month_summary, goal_progress, month_patterns, unresolved_plateaus, encouragement, opening_message. All string values.

opening_message: a short (2-3 sentence) introduction before the report sections, in Coach Joe's voice. Sets the tone for the monthly check-in.
month_summary: total sessions, any PRs, consistency rate, and key volume numbers.
goal_progress: how the athlete tracked against their stated goal this month.
month_patterns: patterns observed across the full month (consistency trends, progression arcs, any notable weeks).
unresolved_plateaus: any lifts that showed plateau across this month. null if none.
encouragement: 2-3 sentences. Specific to what actually happened this month.

Return ONLY valid JSON, no markdown.`;

  const user = `Athlete: ${athlete.name}, Sport: ${athlete.sport}
Goal on file: ${goalText}

THIS MONTH (${sessionCount} sessions):
${sessionsFormatted || "No sessions logged this month."}

PLATEAUS: ${plateaus.length ? plateaus.join(", ") : "None"}
PAIN FLAGS: ${painAreas.length ? painAreas.join(", ") : "None"}`;

  const raw = await askClaudeServer({
    system, user, maxTokens: 1400, feature: "proof_monthly",
    attribution: {
      role: "athlete", actor_id: athlete.id, athlete_id: athlete.id,
      school_id: athlete.school_id ?? null, coach_id: athlete.coach_id ?? null, tier: athlete.tier ?? null,
    },
  });

  let contentJson;
  try {
    contentJson = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    contentJson = {
      opening_message: `${athlete.name.split(" ")[0]}, let's take a look at how your month went.`,
      month_summary: `${sessionCount} sessions logged this month.`,
      goal_progress: "See in-app recap for details.",
      month_patterns: null,
      unresolved_plateaus: plateaus.length ? plateaus.join(", ") : null,
      encouragement: "Keep showing up. That's the job.",
    };
  }

  return {
    contentJson,
    label: `MONTHLY RECAP — ${monthLabel}`,
    has_plateau: plateaus.length > 0,
    has_pain: painAreas.length > 0,
    has_missed: sessionCount === 0,
  };
};

// ── Trigger the separate process-deletions edge function ──────────────────────
// (Privacy Policy §4/§5) — that job stays on Supabase; we only kick it.
const triggerProcessDeletions = async (SUPABASE_URL, SERVICE_KEY) => {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/process-deletions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}`, "apikey": SERVICE_KEY },
      body: "{}",
    });
    let data; try { data = await r.json(); } catch { data = null; }
    console.log("[proof-feed] process-deletions →", r.status, JSON.stringify(data));
    return { fn: "process-deletions", status: r.status, ok: r.ok };
  } catch (e) {
    console.error("[proof-feed] process-deletions failed:", e.message);
    return { fn: "process-deletions", status: 500, ok: false, error: e.message };
  }
};

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Manual triggers must present the cron secret; Vercel signs its own cron calls.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["authorization"] !== `Bearer ${cronSecret}` && req.headers["x-vercel-cron"] !== "1") {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  console.log("[proof-feed] triggered —", new Date().toISOString());
  console.log("[proof-feed] env check — SUPABASE_URL:", !!SUPABASE_URL, "| SERVICE_KEY:", !!SERVICE_KEY, "| RESEND:", !!RESEND_KEY);

  if (!SUPABASE_URL) return res.status(500).json({ error: "Missing SUPABASE_URL" });
  if (!SERVICE_KEY)  return res.status(500).json({ error: "Missing SUPABASE_SERVICE_KEY — add it in Vercel → Settings → Environment Variables" });

  try {
    const now = new Date().toISOString();

    // 1. Athletes explicitly due for a digest.
    const due = await sbSelect(
      "athletes",
      `?next_proof_due_at=lte.${now}&select=*&order=created_at.asc`
    );

    // 2. Bootstrap: athletes who never had a digest but have a session >= 7 days old.
    const bootstrapRaw = await sbSelect("athletes", `?next_proof_due_at=is.null&select=*`);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const bootstrapIds = bootstrapRaw.map((a) => `"${a.id}"`).join(",");
    let bootstrapAthletesWithSessions = [];
    if (bootstrapIds.length > 0) {
      const sessions7d = await sbSelect(
        "workouts",
        `?athlete_id=in.(${bootstrapIds})&created_at=lte.${sevenDaysAgo}&select=athlete_id`
      );
      const hasSession = new Set(sessions7d.map((s) => s.athlete_id));
      bootstrapAthletesWithSessions = bootstrapRaw.filter((a) => hasSession.has(a.id));
    }

    const allDue = [
      ...due,
      ...bootstrapAthletesWithSessions.filter((a) => !due.find((d) => d.id === a.id)),
    ];

    console.log(`[proof-feed] athletes due: ${allDue.length}`);

    const results = [];

    if (allDue.length > 0) {
      const athleteIds = allDue.map((a) => `"${a.id}"`).join(",");
      const now28d = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();

      // Batch-fetch context for all due athletes (last 28d of workouts for monthly).
      const [allWorkoutsRaw, allGoals, allCoaches] = await Promise.all([
        sbSelect("workouts", `?athlete_id=in.(${athleteIds})&created_at=gte.${now28d}&select=*&order=created_at.asc`),
        sbSelect("athlete_goals", `?athlete_id=in.(${athleteIds})&select=*&order=created_at.desc`),
        sbSelect("coaches", `?select=id,name,email`),
      ]);

      for (const athlete of allDue) {
        try {
          const cycleCount = athlete.proof_cycle_count || 1;
          const isMonthly = cycleCount === 4;

          const athleteWorkouts = (allWorkoutsRaw || []).filter((w) => w.athlete_id === athlete.id);
          const athleteGoals = (allGoals || []).filter((g) => g.athlete_id === athlete.id);

          const thisWeekCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          const lastWeekCutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

          const thisWeekWorkouts = athleteWorkouts.filter((w) => w.created_at >= thisWeekCutoff);
          const lastWeekWorkouts = athleteWorkouts.filter((w) => w.created_at >= lastWeekCutoff && w.created_at < thisWeekCutoff);
          const monthWorkouts = athleteWorkouts; // all 28d

          const thisWeekSessions = groupIntoSessions(thisWeekWorkouts);
          const lastWeekSessions = groupIntoSessions(lastWeekWorkouts);
          const monthSessions = groupIntoSessions(monthWorkouts);

          const digestData = isMonthly
            ? await generateMonthlyRecap(athlete, monthSessions, athleteGoals)
            : await generateWeeklyDigest(athlete, thisWeekSessions, lastWeekSessions, monthSessions);

          const coach = allCoaches?.find((c) => c.id === athlete.coach_id);

          // Replace any prior weekly/monthly digest for this athlete.
          await sbDelete("proof_digests", `?athlete_id=eq.${athlete.id}&digest_type=in.(weekly,monthly)`);
          await sbInsert("proof_digests", {
            athlete_id: athlete.id,
            coach_id: athlete.coach_id || null,
            digest_type: isMonthly ? "monthly" : "weekly",
            label: digestData.label,
            content_json: digestData.contentJson,
            is_read: false,
            has_plateau: digestData.has_plateau,
            has_pain: digestData.has_pain,
            has_missed: digestData.has_missed,
          });

          // Monthly also writes a coach report digest.
          if (isMonthly && athlete.coach_id) {
            const coachReport = {
              coach_summary: `${digestData.contentJson.month_summary || ""}\n\n${digestData.contentJson.month_patterns || ""}`.trim(),
              flags: [
                ...(digestData.has_plateau ? ["plateau"] : []),
                ...(digestData.has_pain ? ["pain flag"] : []),
                ...(digestData.has_missed ? ["missed sessions"] : []),
              ],
              program_changes: null, // populated after the reflection dialogue completes
            };
            await sbDelete("proof_digests", `?athlete_id=eq.${athlete.id}&digest_type=eq.monthly_coach`);
            await sbInsert("proof_digests", {
              athlete_id: athlete.id,
              coach_id: athlete.coach_id,
              digest_type: "monthly_coach",
              label: `MONTHLY COACH REPORT — ${athlete.name} — ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}`,
              content_json: coachReport,
              is_read: false,
              has_plateau: digestData.has_plateau,
              has_pain: digestData.has_pain,
              has_missed: digestData.has_missed,
            });
          }

          // Advance the cycle (1,2,3 = weekly; 4 = monthly, then reset to 1) and
          // stamp send time + next due date. One write — the old edge function did
          // this in two redundant PATCHes that set the same value.
          const newCycleCount = isMonthly ? 1 : Math.min(cycleCount + 1, 4);
          const nextDue = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
          await sbWrite({
            method: "PATCH",
            table: "athletes",
            query: `?id=eq.${athlete.id}`,
            body: {
              proof_cycle_count: newCycleCount,
              last_proof_sent_at: new Date().toISOString(),
              next_proof_due_at: nextDue,
            },
            prefer: "return=minimal",
          });

          // Athlete email.
          if (athlete.email) {
            const subject = isMonthly
              ? `Your WILCO Monthly Recap — ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}`
              : `Your WILCO Weekly — Week of ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" })}`;
            const html = buildAthleteDigestEmail(athlete, digestData.contentJson, digestData.label);
            await sendEmail(athlete.email, subject, html);
          }

          // Coach email for monthly.
          if (isMonthly && coach?.email) {
            const coachSubject = `WILCO Monthly Recap — ${athlete.name} — ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}`;
            const coachHtml = buildCoachMonthlyEmail(
              coach, athlete,
              { coach_summary: `${digestData.contentJson.month_summary || ""}\n\n${digestData.contentJson.month_patterns || ""}`.trim(), flags: [digestData.has_plateau && "plateau", digestData.has_pain && "pain flag"].filter(Boolean) },
              digestData.label
            );
            await sendEmail(coach.email, coachSubject, coachHtml);
          }

          results.push({ athlete: athlete.name, type: isMonthly ? "monthly" : "weekly", ok: true });
          console.log(`[proof-feed] processed ${athlete.name} (${isMonthly ? "monthly" : "weekly"})`);
        } catch (e) {
          console.error(`[proof-feed] error for ${athlete.name}:`, e?.message);
          results.push({ athlete: athlete.name, ok: false, error: e?.message });
        }
      }
    }

    // Always also drain the deletion queue (independent of the digest run).
    const deletions = await triggerProcessDeletions(SUPABASE_URL, SERVICE_KEY);

    return res.status(200).json({ processed: results.length, results, deletions });
  } catch (err) {
    console.error("[proof-feed] fatal:", err);
    return res.status(500).json({ error: err.message });
  }
}
