// ─── PROOF FEED ENGINE (Vercel) ──────────────────────────────────────────────
// Generates weekly/monthly athlete digests + weekly/monthly coach reports, writes
// them to proof_digests, and emails them. Also triggers the process-deletions
// edge function (Privacy Policy §4/§5).
//
// HISTORY: the engine used to live in a Supabase edge function that read its DB
// credential from a never-set secret and crashed on every run — the feature never
// produced a digest. It now lives here on Vercel (auto-deploys on push, reads the
// already-set SUPABASE_SERVICE_KEY). All compute + AI generation is in api/_proof.js.
//
// FUNCTION BUDGET: shares this one route with the deletions trigger; the heavy
// logic is in `_`-prefixed helpers (_proof.js / _supa.js) that don't count. Still
// 12/12 Vercel functions.
//
// TWO ENTRY MODES (spec §12):
//   1. Scheduler — cron secret header (CRON_SECRET) or Vercel's x-vercel-cron.
//      Sweeps all DUE athletes + generates coach reports. (Phase 6 replaces the
//      sweep with pg_cron firing one request per due id — see the SQL migration.)
//   2. Run-now — POST { auth:{role,id,pin}, run_now:true } from the app. Generates
//      for THAT athlete only (own id), enforcing the once-per-day cap.
//
// Env: ANTHROPIC_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY,
//      FROM_EMAIL, APP_URL (defaults below), CRON_SECRET.

import { sbSelect, sbInsert, sbWrite, sbDelete, authCaller, httpErr, askClaudeServer } from "./_supa.js";
import {
  groupIntoSessions, aggregateInjuries, buildOneRMs, buildBrief,
  parseProgramIfNeeded, compareProgramVsActual,
  generateWeekly, generateMonthly, generateCoach,
} from "./_proof.js";

const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "WILCO <noreply@trainwilco.com>";
const APP_URL = process.env.APP_URL || "https://app.trainwilco.com";

const todayStr = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

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

// ── Build one athlete's brief from already-fetched batch data ──────────────────
const briefFor = (athlete, batch, windowType) => {
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

  return {
    thisWeekSessions, lastWeekSessions, monthSessions, prs, oneRMs,
    brief: buildBrief({ athlete, thisWeekSessions, lastWeekSessions, monthSessions, prs, goals, adherence: null, injuries, windowType }),
  };
};

// ── Generate + persist one athlete digest ─────────────────────────────────────
async function runAthlete(athlete, batch) {
  const cycleCount = athlete.proof_cycle_count || 1;
  const isMonthly = cycleCount === 4;
  const windowType = isMonthly ? "monthly" : "weekly";

  const attribution = {
    role: "athlete", actor_id: athlete.id, athlete_id: athlete.id,
    school_id: athlete.school_id ?? null, coach_id: athlete.coach_id ?? null, tier: athlete.tier ?? null,
  };
  const deps = { askClaudeServer, sbWrite, sbSelect, attribution };

  const b = briefFor(athlete, batch, windowType);

  // Phase 2: structured program parse (hash-guarded; free if unchanged), then the
  // code-only load+volume adherence comparison.
  const existingRx = (batch.prescriptions || []).find((p) => p.athlete_id === athlete.id) || null;
  try {
    const parsed = athlete.temp_program_text ? null : await parseProgramIfNeeded(athlete, existingRx, deps);
    if (parsed) b.brief.volume = compareProgramVsActual(parsed, b.thisWeekSessions, b.oneRMs);
  } catch (e) { console.error("[proof-feed] program parse failed:", e.message); }

  const digest = isMonthly ? await generateMonthly(athlete, b.brief, deps) : await generateWeekly(athlete, b.brief, deps);

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
  return { athlete: athlete.name, type: windowType };
}

// ── Generate + persist coach reports (team aggregate per coach) ────────────────
// Bounded by total roster; at scale Phase 6's pg_cron fires one request per coach.
async function runCoachReports(allAthletes, batch, coaches) {
  const results = [];
  const byCoach = {};
  for (const a of allAthletes) {
    if (!a.coach_id) continue;
    (byCoach[a.coach_id] = byCoach[a.coach_id] || []).push(a);
  }
  for (const [coachId, roster] of Object.entries(byCoach)) {
    const coach = (coaches || []).find((c) => c.id === coachId);
    if (!coach) continue;
    try {
      const perAthlete = roster.map((a) => ({ athlete: a, brief: briefFor(a, batch, "weekly").brief }));
      const attribution = { role: "coach", actor_id: coach.id, coach_id: coach.id, school_id: coach.school_id ?? null };
      const report = await generateCoach(coach, perAthlete, { askClaudeServer, attribution }, "weekly_coach");
      await sbDelete("proof_digests", `?coach_id=eq.${coach.id}&digest_type=eq.weekly_coach`);
      await sbInsert("proof_digests", {
        athlete_id: null, coach_id: coach.id, digest_type: "weekly_coach",
        label: report.label, content_json: report.contentJson, is_read: false,
        has_plateau: false, has_pain: report.has_pain, has_missed: report.has_missed,
      });
      if (coach.email) await sendEmail(coach.email, `WILCO Coach Report — Week of ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" })}`, buildDigestEmail(coach.name || "Coach", report.contentJson, report.label));
      results.push({ coach: coach.name, athletes: roster.length });
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

const triggerProcessDeletions = async (url, key) => {
  try {
    const r = await fetch(`${url}/functions/v1/process-deletions`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, apikey: key }, body: "{}",
    });
    return { fn: "process-deletions", status: r.status, ok: r.ok };
  } catch (e) { return { fn: "process-deletions", status: 500, ok: false, error: e.message }; }
};

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL) return res.status(500).json({ error: "Missing SUPABASE_URL" });
  if (!SERVICE_KEY) return res.status(500).json({ error: "Missing SUPABASE_SERVICE_KEY — add it in Vercel → Settings → Environment Variables" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // Auth: run-now (authenticated athlete) OR scheduler (cron secret / Vercel cron).
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !cronSecret || req.headers["authorization"] === `Bearer ${cronSecret}` || req.headers["x-vercel-cron"] === "1";
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

    // ── Cron single-target fanout (the scalable path; pg_cron fires one request
    //    per due id so no invocation ever loops the whole roster) ──
    if (body.athlete_id) {
      const rows = await sbSelect("athletes", `?id=eq.${encodeURIComponent(body.athlete_id)}&select=*`);
      const athlete = rows[0];
      if (!athlete) return res.status(404).json({ error: "Athlete not found" });
      if (athlete.proof_enabled === false || athlete.last_proof_run_date === todayStr()) {
        return res.status(200).json({ ok: false, skipped: true });
      }
      const batch = await fetchBatch([athlete.id]);
      return res.status(200).json({ ok: true, athlete: await runAthlete(athlete, batch) });
    }
    if (body.coach_id) {
      const roster = await sbSelect("athletes", `?coach_id=eq.${encodeURIComponent(body.coach_id)}&select=*`);
      const rosterBatch = await fetchBatch(roster.map((a) => a.id));
      const coaches = await sbSelect("coaches", `?id=eq.${encodeURIComponent(body.coach_id)}&select=id,name,email,school_id`);
      const coaches2 = await runCoachReports(roster, rosterBatch, coaches);
      return res.status(200).json({ ok: true, coaches: coaches2 });
    }

    // ── Scheduler sweep (backstop; Phase 6 pg_cron prefers the fanout above) ──
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
      try { results.athletes.push(await runAthlete(athlete, batch)); }
      catch (e) { results.skipped.push({ athlete: athlete.name, error: e.message }); }
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

    const deletions = await triggerProcessDeletions(SUPABASE_URL, SERVICE_KEY);
    return res.status(200).json({ processed: results.athletes.length, ...results, deletions });
  } catch (err) {
    console.error("[proof-feed] fatal:", err);
    return res.status(500).json({ error: err.message });
  }
}
