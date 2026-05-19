// Vercel serverless function — sends weekly progress reports to external coaches.
// Triggered by Vercel Cron every Monday at 9 AM ET, or manually via GET.

export default async function handler(req, res) {
  // Simple auth check for manual triggers — skip for cron (Vercel signs cron requests)
  const cronSecret = process.env.CRON_SECRET;
  if(cronSecret && req.headers["authorization"] !== `Bearer ${cronSecret}` && req.headers["x-vercel-cron"] !== "1") {
    return res.status(401).json({error:"Unauthorized"});
  }

  const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
  const SUPABASE_KEY = process.env.VITE_SUPABASE_KEY;
  const RESEND_KEY   = process.env.RESEND_API_KEY;
  const FROM_EMAIL   = process.env.FROM_EMAIL   || "WILCO <reports@wilco.app>";
  const SIGNUP_URL   = process.env.TEAM_SIGNUP_URL || "https://wilco.app/coaches";

  console.log("[weekly-report] triggered —", new Date().toISOString());
  console.log("[weekly-report] env check — SUPABASE_URL:", !!SUPABASE_URL, "| SUPABASE_KEY:", !!SUPABASE_KEY, "| RESEND_KEY:", !!RESEND_KEY, "| FROM_EMAIL:", FROM_EMAIL);

  if(!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({error:"Missing Supabase config"});
  if(!RESEND_KEY)                    return res.status(500).json({error:"Missing RESEND_API_KEY — add this in Vercel → Settings → Environment Variables"});

  const sbH = {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json"
  };

  // Date range: past 7 days
  const now     = new Date();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const weekAgoISO = weekAgo.toISOString();
  const weekLabel  = weekAgo.toLocaleDateString("en-US", {month:"long", day:"numeric"});

  // ── Fetch Pro/Elite athletes with a coach email set ─────────────────────
  // Free tier does not receive weekly progress reports — only Pro and Elite
  const athRes  = await fetch(`${SUPABASE_URL}/rest/v1/athletes?coach_email=not.is.null&tier=in.(pro,elite)&select=*`, {headers:sbH});
  const athletes = await athRes.json();
  if(!Array.isArray(athletes) || athletes.length === 0) {
    return res.status(200).json({message:"No Pro/Elite athletes with coach emails set.", sent:0});
  }

  // ── Group athletes by coach email ────────────────────────────────────────
  const byCoach = {};
  athletes.forEach(a => {
    const key = a.coach_email.trim().toLowerCase();
    if(!byCoach[key]) byCoach[key] = {email:a.coach_email.trim(), name:a.coach_name||"Coach", athletes:[]};
    byCoach[key].athletes.push(a);
  });

  // ── Fetch all workouts + PRs from this week in one shot ──────────────────
  const allIds = athletes.map(a => a.id);
  const idList = allIds.map(id => `"${id}"`).join(",");

  const [wRes, pRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/workouts?athlete_id=in.(${idList})&created_at=gte.${weekAgoISO}&select=*&order=created_at.asc`, {headers:sbH}),
    fetch(`${SUPABASE_URL}/rest/v1/prs?athlete_id=in.(${idList})&created_at=gte.${weekAgoISO}&select=*`, {headers:sbH})
  ]);
  const allWorkouts = await wRes.json();
  const allPRs      = await pRes.json();

  // ── Send one email per coach ─────────────────────────────────────────────
  const results = [];
  for(const coach of Object.values(byCoach)) {
    const athIds = new Set(coach.athletes.map(a => a.id));
    const workouts = Array.isArray(allWorkouts) ? allWorkouts.filter(w => athIds.has(w.athlete_id)) : [];
    const prs      = Array.isArray(allPRs)      ? allPRs.filter(p => athIds.has(p.athlete_id))      : [];

    const html = buildEmail(coach, workouts, prs, weekLabel, SIGNUP_URL);

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {"Authorization":`Bearer ${RESEND_KEY}`, "Content-Type":"application/json"},
      body: JSON.stringify({
        from: FROM_EMAIL,
        to:   [coach.email],
        subject: `WILCO Weekly Progress Report — Week of ${weekLabel}`,
        html
      })
    });
    const emailData = await emailRes.json();
    const result = {coach:coach.email, athletes:coach.athletes.length, sessions:workouts.filter(isRealEntry).length, status:emailRes.status, id:emailData.id, error:emailData.message||emailData.error||null};
    console.log("[weekly-report] email result:", JSON.stringify(result));
    results.push(result);
  }

  console.log("[weekly-report] done — sent:", results.length);
  return res.status(200).json({sent:results.length, results});
}

// ── Helpers ────────────────────────────────────────────────────────────────────
const getPD = (w) => {
  if(typeof w.parsed_data === "string"){
    try { return JSON.parse(w.parsed_data); } catch { return {}; }
  }
  return w.parsed_data || {};
};

// A real training session has exercises OR run data (filters out pure Q&A messages)
const isRealEntry = (w) => {
  const pd = getPD(w);
  return pd.exercises?.length > 0 || !!pd.run_data;
};

// Groups workout entries within a 3-hour window into one session.
const GAP_MS = 3 * 60 * 60 * 1000;
function groupIntoSessions(workouts) {
  const real   = workouts.filter(isRealEntry);
  const sorted = [...real].sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
  const groups = [];
  let cur = null, lastTime = null;
  sorted.forEach(w => {
    const t  = new Date(w.created_at).getTime();
    const pd = getPD(w);
    if(!lastTime || pd.new_session === true || t - lastTime > GAP_MS) {
      cur = [w]; groups.push(cur);
    } else {
      cur.push(w);
    }
    lastTime = t;
  });
  return groups;
}

// Merges entries in a session group into one display row.
function mergeSession(entries) {
  const date     = new Date(entries[0].created_at).toLocaleDateString("en-US", {weekday:"short", month:"short", day:"numeric"});
  const exercises = [];
  const painAreas = [];
  const feelRank  = {rough:0, average:1, good:2, great:3};
  let feel    = null;
  let runData = null;
  entries.forEach(w => {
    const pd = getPD(w);
    (pd.exercises || []).forEach(e => { if(e.name) exercises.push(e); });
    (pd.pain_flags || []).forEach(p => { if(!painAreas.includes(p.area)) painAreas.push(p.area); });
    if(pd.session_feel && (feel === null || feelRank[pd.session_feel] < feelRank[feel])) {
      feel = pd.session_feel;
    }
    if(pd.run_data && !runData) runData = pd.run_data; // take first run entry
  });
  return { date, exercises, painAreas, feel, runData };
}

// ── Email builder ──────────────────────────────────────────────────────────────
function buildEmail(coach, workouts, prs, weekLabel, signupUrl) {
  const epley = (w, r) => (!w || w <= 0) ? 0 : Math.round(w * (1 + (r||1) / 30));

  // ── Per-athlete sections ─────────────────────────────────────────────────
  const athleteSections = coach.athletes.map(ath => {
    const athWorkouts = workouts.filter(w => w.athlete_id === ath.id);
    const athPRs      = prs.filter(p => p.athlete_id === ath.id);

    // Group entries into sessions using the 3-hour rule
    const sessionGroups = groupIntoSessions(athWorkouts);
    const sessions      = sessionGroups.map(mergeSession);

    // Collect all pain areas across the week (for the summary flag)
    const painAreas = [];
    athWorkouts.forEach(w => {
      getPD(w).pain_flags?.forEach(p => { if(!painAreas.includes(p.area)) painAreas.push(p.area); });
    });

    // Build session rows — one row per merged session (handles both strength and runs)
    const sessionRows = sessions.map(({ date, exercises, runData, feel }) => {
      let content = "";
      if(runData) {
        // Run session
        const parts = [];
        if(runData.run_type) parts.push(`<strong>${runData.run_type.replace("_"," ").replace(/\b\w/g,c=>c.toUpperCase())}</strong>`);
        if(runData.distance_miles) parts.push(`${runData.distance_miles} mi`);
        else if(runData.distance_km) parts.push(`${runData.distance_km} km`);
        if(runData.duration_minutes) parts.push(`${runData.duration_minutes} min`);
        if(runData.pace_per_mile) parts.push(`${runData.pace_per_mile}/mi`);
        else if(runData.pace_per_km) parts.push(`${runData.pace_per_km}/km`);
        if(runData.heart_rate_avg) parts.push(`avg HR ${runData.heart_rate_avg} bpm`);
        content = parts.length ? parts.join(" &middot; ") : "<span style='color:#aaa'>Run</span>";
        content = `<span style="color:#3b82f6;font-size:10px;font-weight:700;letter-spacing:1px">RUN &nbsp;</span>${content}`;
      } else {
        // Strength session
        content = exercises.filter(e => e.name).map(e => {
          let s = `<span style="color:#1a1a2e;font-weight:600">${e.name}</span>`;
          if(e.sets && e.reps) s += ` <span style="color:#555">${e.sets}×${e.reps}</span>`;
          if(e.weight) {
            const u = e.unit === "kg" ? "kg" : "lbs";
            s += ` <span style="color:#555">@ ${e.weight}${u}</span>`;
          }
          return s;
        }).join(" &nbsp;·&nbsp; ") || "<span style='color:#aaa'>General training</span>";
      }
      const feelHtml = feel
        ? `<span style="color:${feel==='rough'?'#c0392b':feel==='great'||feel==='good'?'#27ae60':'#888'};font-size:11px;margin-left:8px">${feel}</span>`
        : "";
      return `
        <tr>
          <td style="padding:7px 12px;border-bottom:1px solid #eaeaea;color:#888;font-size:12px;white-space:nowrap;vertical-align:top">${date}</td>
          <td style="padding:7px 12px;border-bottom:1px solid #eaeaea;font-size:13px;line-height:1.6">${content}${feelHtml}</td>
        </tr>`;
    }).join("");

    const prRows = athPRs.map(p => {
      const e1rm = p.estimated_1rm || epley(p.weight, p.reps||1);
      return `<li style="margin:4px 0;font-size:13px"><strong>${p.exercise}</strong> — ${p.weight}lbs × ${p.reps||1} rep${(p.reps||1)>1?"s":""} <span style="color:#888">(est. 1RM: ${e1rm}lbs)</span></li>`;
    }).join("");

    const painHtml = painAreas.length > 0
      ? `<div style="background:#fff5f5;border-left:3px solid #e74c3c;padding:8px 12px;margin:12px 0;border-radius:0 6px 6px 0;font-size:13px">
           <strong style="color:#c0392b">⚠ Pain / discomfort flagged:</strong> ${painAreas.join(", ")}
         </div>`
      : "";

    const prHtml = athPRs.length > 0
      ? `<div style="background:#f0fff4;border-left:3px solid #27ae60;padding:8px 12px;margin:12px 0;border-radius:0 6px 6px 0">
           <strong style="color:#27ae60;font-size:13px">🏆 New PRs this week:</strong>
           <ul style="margin:6px 0 0 0;padding-left:16px">${prRows}</ul>
         </div>`
      : "";

    const noActivity = sessions.length === 0
      ? `<p style="color:#aaa;font-size:13px;margin:8px 0">No training sessions logged this week.</p>`
      : "";

    return `
      <div style="margin-bottom:28px;border:1px solid #e0e0e0;border-radius:10px;overflow:hidden">
        <div style="background:#0a1228;padding:12px 18px;display:flex;justify-content:space-between;align-items:center">
          <div>
            <span style="color:#d4a017;font-family:Arial,sans-serif;font-size:16px;font-weight:700;letter-spacing:1px">${ath.name.toUpperCase()}</span>
            <span style="color:#64748b;font-size:12px;margin-left:10px">${ath.sport}</span>
          </div>
          <span style="color:#e2e8f0;font-size:13px">${sessions.length} session${sessions.length!==1?"s":""} this week</span>
        </div>
        <div style="padding:14px 18px;background:#fff">
          ${noActivity}
          ${sessions.length > 0 ? `
          <table style="width:100%;border-collapse:collapse;margin-bottom:8px">
            <thead>
              <tr style="background:#f8f8f8">
                <th style="padding:6px 12px;text-align:left;font-size:11px;color:#999;letter-spacing:1px;border-bottom:2px solid #eaeaea;white-space:nowrap">DATE</th>
                <th style="padding:6px 12px;text-align:left;font-size:11px;color:#999;letter-spacing:1px;border-bottom:2px solid #eaeaea">EXERCISES</th>
              </tr>
            </thead>
            <tbody>${sessionRows}</tbody>
          </table>` : ""}
          ${painHtml}
          ${prHtml}
        </div>
      </div>`;
  }).join("");

  // ── Full email HTML ──────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px">

    <!-- Header -->
    <div style="background:#060d1e;border-radius:12px 12px 0 0;padding:24px 28px;text-align:center">
      <div style="font-size:42px;font-weight:900;color:#d4a017;letter-spacing:6px;font-family:Arial,sans-serif">WILCO</div>
      <div style="color:#64748b;font-size:12px;letter-spacing:4px;margin-top:4px">WEEKLY PROGRESS REPORT</div>
      <div style="color:#94a3b8;font-size:13px;margin-top:8px">Week of ${weekLabel}</div>
    </div>

    <!-- Body -->
    <div style="background:#fff;padding:28px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0">
      <p style="color:#1a1a2e;font-size:15px;margin:0 0 20px">Hi ${coach.name},</p>
      <p style="color:#444;font-size:14px;line-height:1.6;margin:0 0 24px">
        Here's your weekly update from WILCO — a summary of what your athletes have been up to in the gym this week.
      </p>

      ${athleteSections}
    </div>

    <!-- CTA / Pitch -->
    <div style="background:#0a1228;padding:28px;border-radius:0 0 12px 12px;text-align:center">
      <div style="color:#d4a017;font-size:18px;font-weight:700;letter-spacing:1px;margin-bottom:10px">BRING WILCO TO YOUR TEAM</div>
      <p style="color:#94a3b8;font-size:13px;line-height:1.7;margin:0 0 18px">
        Get the full coaching dashboard — view every athlete's progress charts, log custom programs,
        and brand the app with your school or team's logo and colors. No tech setup required.
      </p>
      <a href="${signupUrl}" style="display:inline-block;background:#d4a017;color:#000;font-weight:700;font-size:14px;letter-spacing:1px;padding:13px 32px;border-radius:8px;text-decoration:none">
        SET UP YOUR TEAM ACCOUNT →
      </a>
      <p style="color:#475569;font-size:11px;margin:16px 0 0">
        This report was requested by one of your athletes via WILCO. To unsubscribe, reply to this email.
      </p>
    </div>

  </div>
</body>
</html>`;
}
