// ─── PROOF FEED DAILY EDGE FUNCTION ──────────────────────────────────────────
// Supabase Edge Function — runs daily via pg_cron or Supabase Dashboard scheduler.
// Checks all athletes where next_proof_due_at <= now(), generates the appropriate
// digest (weekly or monthly recap pre-report), stores it, sends push + email.
//
// Deploy:  supabase functions deploy proof-feed-daily
// Schedule via Supabase Dashboard → Database → Extensions → pg_cron:
//   SELECT cron.schedule('proof-feed-daily','0 10 * * *',
//     $$SELECT net.http_post(
//       url := 'https://<project>.supabase.co/functions/v1/proof-feed-daily',
//       headers := '{"Content-Type":"application/json","Authorization":"Bearer <service_key>"}',
//       body := '{}'
//     )$$);
//
// Required env vars (Supabase Dashboard → Settings → Edge Functions → Secrets):
//   ANTHROPIC_KEY      — Anthropic API key
//   SUPABASE_URL       — your project URL
//   SUPABASE_SERVICE_KEY — service role key (full DB access)
//   RESEND_API_KEY     — Resend email API key
//   FROM_EMAIL         — sender address, e.g. "WILCO <noreply@wilco.app>"
//   APP_URL            — public app URL, e.g. "https://wilco.app"
//   VAPID_PUBLIC_KEY   — Web Push VAPID public key (generate with web-push CLI)
//   VAPID_PRIVATE_KEY  — Web Push VAPID private key
//   VAPID_SUBJECT      — e.g. "mailto:admin@wilco.app"

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const ANTHROPIC_KEY      = Deno.env.get("ANTHROPIC_KEY")!;
const SUPABASE_URL        = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY= Deno.env.get("SERVICE_KEY")!;
const RESEND_KEY          = Deno.env.get("RESEND_API_KEY")!;
const FROM_EMAIL          = Deno.env.get("FROM_EMAIL") || "WILCO <noreply@wilco.app>";
const APP_URL             = Deno.env.get("APP_URL") || "https://wilco.app";
const VAPID_PUBLIC_KEY    = Deno.env.get("VAPID_PUBLIC_KEY") || "";
const VAPID_PRIVATE_KEY   = Deno.env.get("VAPID_PRIVATE_KEY") || "";
const VAPID_SUBJECT       = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@wilco.app";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Supabase helpers ──────────────────────────────────────────────────────────
const sbH = {
  "Content-Type": "application/json",
  "apikey": SUPABASE_SERVICE_KEY,
  "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Prefer": "return=representation",
};

const sbGet = async (table: string, params = "") => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, { headers: sbH });
  return r.json();
};

const sbInsert = async (table: string, data: unknown) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST", headers: sbH, body: JSON.stringify(data),
  });
  return r.json();
};

const sbUpsert = async (table: string, data: unknown, onConflict: string) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: { ...sbH, "Prefer": "return=representation,resolution=merge-duplicates" },
    body: JSON.stringify(data),
  });
  return r.json();
};

const sbUpdate = async (table: string, params: string, data: unknown) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, {
    method: "PATCH", headers: sbH, body: JSON.stringify(data),
  });
  return r.json();
};

const sbDelete = async (table: string, params: string) => {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, {
    method: "DELETE", headers: sbH,
  });
};

// ── Claude helper ─────────────────────────────────────────────────────────────
const askClaude = async (system: string, user: string, maxTokens = 1200): Promise<string> => {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.content?.[0]?.text || "";
};

// ── Workout helpers ───────────────────────────────────────────────────────────
const getPD = (w: any) => {
  if (typeof w.parsed_data === "string") {
    try { return JSON.parse(w.parsed_data); } catch { return {}; }
  }
  return w.parsed_data || {};
};

const isRealSession = (w: any) => {
  const pd = getPD(w);
  return pd.exercises?.length > 0 || !!pd.run_data;
};

const GAP_MS = 3 * 60 * 60 * 1000;
const groupIntoSessions = (workouts: any[]) => {
  const real = workouts.filter(isRealSession)
    .sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const groups: any[][] = [];
  let cur: any[] | null = null, lastTime = 0;
  real.forEach((w: any) => {
    const t = new Date(w.created_at).getTime();
    const pd = getPD(w);
    if (!lastTime || pd.new_session === true || t - lastTime > GAP_MS) {
      cur = [w]; groups.push(cur);
    } else {
      cur!.push(w);
    }
    lastTime = t;
  });
  return groups;
};

const epley1RM = (weight: number, reps: number) => {
  if (!weight || weight <= 0) return 0;
  if (!reps || reps <= 1) return weight;
  return Math.round(weight * (1 + reps / 30));
};

// ── Format session for AI context ─────────────────────────────────────────────
const formatSessionForAI = (group: any[]) => {
  const date = new Date(group[0].created_at).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
  const exercises = group.flatMap((e: any) => getPD(e).exercises || []);
  const runData = group.map((e: any) => getPD(e).run_data).find(Boolean);
  const painFlags = group.flatMap((e: any) => getPD(e).pain_flags || []);
  const feel = group.map((e: any) => getPD(e).session_feel).find(Boolean);

  if (runData) {
    const parts = [
      runData.run_type || "run",
      runData.distance_miles ? `${runData.distance_miles}mi` : runData.distance_km ? `${runData.distance_km}km` : "",
      runData.pace_per_mile ? `@${runData.pace_per_mile}/mi` : runData.pace_per_km ? `@${runData.pace_per_km}/km` : "",
      runData.duration_minutes ? `${runData.duration_minutes}min` : "",
    ].filter(Boolean);
    return `${date}: RUN — ${parts.join(" ")}${feel ? ` (${feel})` : ""}${painFlags.length ? ` | PAIN: ${painFlags.map((p: any) => p.area).join(", ")}` : ""}`;
  }

  const exStr = exercises.map((e: any) =>
    `${e.name}${e.weight ? ` ${e.weight}${e.unit === "kg" ? "kg" : "lbs"}` : ""}${e.sets && e.reps ? ` ${e.sets}x${e.reps}` : ""}${e.feel ? ` (${e.feel})` : ""}`
  ).join(", ");
  return `${date}: ${exStr || "general training"}${feel ? ` | feel: ${feel}` : ""}${painFlags.length ? ` | PAIN: ${painFlags.map((p: any) => p.area).join(", ")}` : ""}`;
};

// ── Compute per-lift 1RM history ──────────────────────────────────────────────
const buildLiftHistory = (sessions: any[][]) => {
  // Returns { liftName: [{date, e1rm, weight, reps}] }
  const byLift: Record<string, { date: string; e1rm: number; weight: number; reps: number }[]> = {};
  for (const group of sessions) {
    const date = group[0].created_at;
    const exercises = group.flatMap((e: any) => getPD(e).exercises || []);
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
const detectPlateaus = (liftHistory: Record<string, any[]>): string[] => {
  const flagged: string[] = [];
  for (const [lift, entries] of Object.entries(liftHistory)) {
    if (entries.length < 3) continue;
    const last3 = entries.slice(-3);
    const e1rms = last3.map((e: any) => e.e1rm);
    const max = Math.max(...e1rms), min = Math.min(...e1rms);
    if (max - min <= 2.5) flagged.push(lift);
  }
  return flagged;
};

// ── Email: athlete weekly digest ──────────────────────────────────────────────
const buildAthleteDigestEmail = (athlete: any, contentJson: any, label: string): string => {
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
const buildCoachMonthlyEmail = (coach: any, athlete: any, contentJson: any, label: string): string => {
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
    ${c.coach_summary ? `<div style="background:#f8f8f8;border-radius:8px;padding:16px;font-size:14px;line-height:1.7;color:#333">${c.coach_summary.replace(/\n/g,"<br>")}</div>` : ""}
    ${c.flags?.length ? `<div style="background:#fff5f5;border-left:3px solid #e74c3c;padding:10px 14px;margin:16px 0;border-radius:0 6px 6px 0"><strong style="color:#c0392b">Flags:</strong> ${c.flags.join(", ")}</div>` : ""}
    ${c.program_changes ? `<div style="background:#f0fff4;border-left:3px solid #27ae60;padding:10px 14px;margin:16px 0;border-radius:0 6px 6px 0"><strong style="color:#27ae60">Program changes made:</strong> ${c.program_changes}</div>` : ""}
  </div>
  <div style="background:#060d1e;border-radius:0 0 12px 12px;padding:16px;text-align:center">
    <p style="color:#475569;font-size:11px;margin:0">View full recap in the WILCO dashboard.</p>
  </div>
</div></body></html>`;
};

// ── Web Push helper ───────────────────────────────────────────────────────────
// Sends a Web Push notification using VAPID. Uses the web-push compatible approach.
// For Deno we implement the VAPID JWT + encryption manually via SubtleCrypto.
// This is a minimal implementation — for production, consider a Deno web-push library.
const sendPushNotification = async (subscription: any, title: string, body: string) => {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return; // skip if VAPID not configured
  try {
    // Dynamically import web-push compatible library for Deno
    // We'll use a simple fetch to a helper or a Deno-compatible approach
    // For now, call the Supabase edge function approach with raw web push protocol
    // This requires the web-push npm package or a Deno equivalent

    // Minimal VAPID JWT + web push — full implementation:
    const endpoint = subscription.endpoint;
    const keys = subscription.keys;

    // Build VAPID JWT
    const vapidJwt = await buildVapidJwt(endpoint);
    if (!vapidJwt) return;

    // For the actual encrypted push payload, we need ECDH + AES-GCM.
    // This is complex in raw Deno — for production, use supabase edge function with
    // the web-push npm ESM build. Here we send a minimal notification.
    const payload = JSON.stringify({ title, body, url: APP_URL });
    const encodedPayload = new TextEncoder().encode(payload);

    // Simple push without body encryption (works if no payload is needed for basic notification)
    await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `vapid t=${vapidJwt},k=${VAPID_PUBLIC_KEY}`,
        "Content-Type": "application/octet-stream",
        "TTL": "86400",
      },
      body: encodedPayload,
    });
  } catch (e) {
    console.error("[push] failed:", e);
  }
};

const buildVapidJwt = async (endpoint: string): Promise<string | null> => {
  try {
    const url = new URL(endpoint);
    const audience = `${url.protocol}//${url.host}`;
    const now = Math.floor(Date.now() / 1000);
    const header = btoa(JSON.stringify({ typ: "JWT", alg: "ES256" })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const payload = btoa(JSON.stringify({ aud: audience, exp: now + 43200, sub: VAPID_SUBJECT })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const unsigned = `${header}.${payload}`;

    // Import VAPID private key (base64url DER or raw 32 bytes)
    const privateKeyBytes = base64UrlDecode(VAPID_PRIVATE_KEY);
    const key = await crypto.subtle.importKey(
      "raw", privateKeyBytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(unsigned)
    );
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    return `${unsigned}.${sigB64}`;
  } catch {
    return null;
  }
};

const base64UrlDecode = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + (4 - s.length % 4) % 4, "=");
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
};

// ── Send Resend email helper ──────────────────────────────────────────────────
const sendEmail = async (to: string, subject: string, html: string) => {
  if (!RESEND_KEY || !to) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
    });
  } catch (e) {
    console.error("[email] failed:", e);
  }
};

// ── GENERATE WEEKLY DIGEST ────────────────────────────────────────────────────
const generateWeeklyDigest = async (athlete: any, thisWeekSessions: any[][], lastWeekSessions: any[][], allMonthSessions: any[][]) => {
  const now = new Date();
  const weekLabel = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  // Sessions this week vs last week counts
  const thisWeekCount = thisWeekSessions.length;
  const lastWeekCount = lastWeekSessions.length;

  // This-month session count (for "logged X this month")
  const thisMonthCount = allMonthSessions.length;

  // Lift comparison: this week vs last week
  const thisWeekLifts = buildLiftHistory(thisWeekSessions);
  const lastWeekLifts = buildLiftHistory(lastWeekSessions);

  const liftLines: string[] = [];
  for (const [lift, entries] of Object.entries(thisWeekLifts)) {
    const best = entries.reduce((a: any, b: any) => b.e1rm > a.e1rm ? b : a);
    const lastWeek = lastWeekLifts[lift];
    if (lastWeek) {
      const lastBest = lastWeek.reduce((a: any, b: any) => b.e1rm > a.e1rm ? b : a);
      const diff = best.e1rm - lastBest.e1rm;
      const dir = diff > 0 ? `+${Math.round(diff)} lbs` : diff < 0 ? `${Math.round(diff)} lbs` : "no change";
      const color = diff > 0 ? "↑" : diff < 0 ? "↓" : "→";
      liftLines.push(`${lift}: ${best.weight} lbs (est. 1RM ${best.e1rm}) ${color} ${dir} from last week`);
    } else {
      liftLines.push(`${lift}: ${best.weight} lbs (est. 1RM ${best.e1rm}) — new this week`);
    }
  }

  // Plateau detection across rolling sessions (need more than 3 sessions total)
  const allLiftHistory = buildLiftHistory([...lastWeekSessions, ...thisWeekSessions]);
  const plateaus = detectPlateaus(allLiftHistory);

  // Pain flags this week
  const painAreas = thisWeekSessions.flatMap(g =>
    g.flatMap((e: any) => getPD(e).pain_flags || []).map((p: any) => p.area)
  );

  // Format sessions for AI context
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

  const raw = await askClaude(system, user, 1200);
  let contentJson: any;
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
const generateMonthlyRecap = async (athlete: any, monthSessions: any[][], athleteGoals: any[]) => {
  const now = new Date();
  const monthLabel = now.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const liftHistory = buildLiftHistory(monthSessions);
  const plateaus = detectPlateaus(liftHistory);
  const painAreas = monthSessions.flatMap(g =>
    g.flatMap((e: any) => getPD(e).pain_flags || []).map((p: any) => p.area)
  );
  const sessionCount = monthSessions.length;
  const sessionsFormatted = monthSessions.map(formatSessionForAI).join("\n");
  const goalText = athleteGoals?.map((g: any) => g.goal_text).filter(Boolean).slice(0, 3).join(" | ") || "No specific goals on file";

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

  const raw = await askClaude(system, user, 1400);
  let contentJson: any;
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

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const log = (...args: unknown[]) => console.log("[proof-feed-daily]", ...args);

  try {
    const now = new Date().toISOString();
    log("triggered at", now);

    // 1. Find all athletes due for a digest
    const due: any[] = await sbGet(
      "athletes",
      `?next_proof_due_at=lte.${now}&select=*&order=created_at.asc`
    );

    // Also include athletes who have never had a digest sent but have at least one session >= 7 days ago
    // (bootstrap for existing athletes)
    const bootstrapRaw: any[] = await sbGet(
      "athletes",
      `?next_proof_due_at=is.null&select=*`
    );

    // For bootstrap athletes, check if they have sessions >= 7 days old
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const bootstrapIds = bootstrapRaw.map((a: any) => `"${a.id}"`).join(",");
    let bootstrapAthletesWithSessions: any[] = [];
    if (bootstrapIds.length > 0) {
      const sessions7d: any[] = await sbGet(
        "workouts",
        `?athlete_id=in.(${bootstrapIds})&created_at=lte.${sevenDaysAgo}&select=athlete_id`
      );
      const hasSession = new Set(sessions7d.map((s: any) => s.athlete_id));
      bootstrapAthletesWithSessions = bootstrapRaw.filter((a: any) => hasSession.has(a.id));
    }

    const allDue = [
      ...due,
      ...bootstrapAthletesWithSessions.filter((a: any) => !due.find((d: any) => d.id === a.id)),
    ];

    log(`athletes due: ${allDue.length}`);
    if (allDue.length === 0) {
      return new Response(JSON.stringify({ processed: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const athleteIds = allDue.map((a: any) => `"${a.id}"`).join(",");
    const now28d = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
    const now14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    // Batch fetch workouts for all due athletes (last 28 days for monthly context)
    const [allWorkoutsRaw, allGoals, allPushSubs, allCoaches] = await Promise.all([
      sbGet("workouts", `?athlete_id=in.(${athleteIds})&created_at=gte.${now28d}&select=*&order=created_at.asc`),
      sbGet("athlete_goals", `?athlete_id=in.(${athleteIds})&select=*&order=created_at.desc`),
      sbGet("push_subscriptions", `?athlete_id=in.(${athleteIds})&select=*`),
      sbGet("coaches", `?select=id,name,email`),
    ]);

    const results: any[] = [];

    for (const athlete of allDue) {
      try {
        const cycleCount = athlete.proof_cycle_count || 1;
        const isMonthly = cycleCount === 4;

        const athleteWorkouts: any[] = (allWorkoutsRaw || []).filter((w: any) => w.athlete_id === athlete.id);
        const athleteGoals: any[] = (allGoals || []).filter((g: any) => g.athlete_id === athlete.id);
        const pushSub = (allPushSubs || []).find((p: any) => p.athlete_id === athlete.id);

        // Segment workouts
        const thisWeekCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const lastWeekCutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

        const thisWeekWorkouts = athleteWorkouts.filter((w: any) => w.created_at >= thisWeekCutoff);
        const lastWeekWorkouts = athleteWorkouts.filter((w: any) => w.created_at >= lastWeekCutoff && w.created_at < thisWeekCutoff);
        const monthWorkouts = athleteWorkouts; // all 28d

        const thisWeekSessions = groupIntoSessions(thisWeekWorkouts);
        const lastWeekSessions = groupIntoSessions(lastWeekWorkouts);
        const monthSessions = groupIntoSessions(monthWorkouts);

        let digestData: any;
        if (isMonthly) {
          digestData = await generateMonthlyRecap(athlete, monthSessions, athleteGoals);
        } else {
          digestData = await generateWeeklyDigest(athlete, thisWeekSessions, lastWeekSessions, monthSessions);
        }

        const coach = allCoaches?.find((c: any) => c.id === athlete.coach_id);

        // Delete previous digest for this athlete
        await sbDelete("proof_digests", `?athlete_id=eq.${athlete.id}&digest_type=in.(weekly,monthly)`);

        // Insert new digest
        const newDigest: any = await sbInsert("proof_digests", {
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

        // For monthly: also insert a coach report digest
        if (isMonthly && athlete.coach_id) {
          const coachReport = {
            coach_summary: `${digestData.contentJson.month_summary || ""}\n\n${digestData.contentJson.month_patterns || ""}`.trim(),
            flags: [
              ...(digestData.has_plateau ? ["plateau"] : []),
              ...(digestData.has_pain ? ["pain flag"] : []),
              ...(digestData.has_missed ? ["missed sessions"] : []),
            ],
            program_changes: null, // populated after reflection dialogue completes
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

        // Update athlete cycle
        const nextCycle = isMonthly ? 1 : (cycleCount % 3) + 1; // 1→2→3→4→1
        const nextDue = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        await sbUpdate("athletes", `?id=eq.${athlete.id}`, {
          proof_cycle_count: isMonthly ? 1 : cycleCount + 1 > 3 ? 4 : cycleCount + 1,
          last_proof_sent_at: new Date().toISOString(),
          next_proof_due_at: nextDue,
        });

        // Actually the cycle logic: counts 1,2,3=weekly, count 4=monthly
        // After generation: if was count 4 → reset to 1. If was count 1/2/3 → increment.
        const newCycleCount = isMonthly ? 1 : Math.min(cycleCount + 1, 4);
        await sbUpdate("athletes", `?id=eq.${athlete.id}`, {
          proof_cycle_count: newCycleCount,
        });

        // Send push notification
        if (pushSub?.subscription_json) {
          const pushTitle = isMonthly
            ? "Time for your monthly check-in with Coach Joe"
            : `Your weekly Proof Feed is ready, ${athlete.name.split(" ")[0]}`;
          const pushBody = isMonthly ? "Tap to get started." : "Tap to view.";
          await sendPushNotification(pushSub.subscription_json, pushTitle, pushBody);
        }

        // Send athlete email
        if (athlete.email) {
          const subject = isMonthly
            ? `Your WILCO Monthly Recap — ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}`
            : `Your WILCO Weekly — Week of ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" })}`;
          const html = buildAthleteDigestEmail(athlete, digestData.contentJson, digestData.label);
          await sendEmail(athlete.email, subject, html);
        }

        // Send coach email for monthly
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
        log(`processed ${athlete.name} (${isMonthly ? "monthly" : "weekly"})`);
      } catch (e: any) {
        log(`error for ${athlete.name}:`, e?.message);
        results.push({ athlete: athlete.name, ok: false, error: e?.message });
      }
    }

    return new Response(JSON.stringify({ processed: results.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[proof-feed-daily] fatal:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
