// Vercel serverless function — sends a welcome email to a coach when an athlete signs up.
// Called from the client-side signup flow immediately after athlete creation.
//
// AUTH: authenticated athlete only (the freshly-created account, which has a live
// session by the time this fires) + per-IP rate limit. Same open-relay reasoning
// as send-coach-invite: caller controls both the recipient and body text, so an
// unauthenticated version could send WILCO-branded mail to anyone.

import { authCaller, authThrottle, rateLimit, clientIp } from "./_supa.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const RESEND_KEY  = process.env.RESEND_API_KEY;
  const FROM_EMAIL  = process.env.FROM_EMAIL  || "WILCO <reports@wilco.app>";
  const SIGNUP_URL  = process.env.TEAM_SIGNUP_URL || "https://wilco.app/coaches";

  if (!RESEND_KEY) return res.status(500).json({ error: "Missing RESEND_API_KEY" });

  const { auth, athleteName, athleteSport, coachName, coachEmail } = req.body || {};

  // Require a valid athlete session; throttle the PIN-fallback brute-force path.
  try {
    const recordAuthFail = await authThrottle(`coach-welcome-authfail:${clientIp(req)}`);
    let caller;
    try { caller = await authCaller(auth); }
    catch (e) { if (e.status === 401) await recordAuthFail(); throw e; }
    if (caller.role !== "athlete") return res.status(403).json({ error: "Not authorized" });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message || "Unauthorized" });
  }
  // Cap outbound volume per IP regardless of auth (a valid session shouldn't fire
  // dozens of coach notifications). Silent success so signup UX is never blocked.
  try { await rateLimit(`coach-welcome:${clientIp(req)}`, { max: 10, windowMin: 60 }); }
  catch { return res.status(200).json({ sent: false, throttled: true }); }

  if (!coachEmail)   return res.status(400).json({ error: "coachEmail is required" });
  if (!athleteName)  return res.status(400).json({ error: "athleteName is required" });

  const displayCoach   = coachName   || "Coach";
  const displaySport   = athleteSport || "General Fitness";
  const initial        = athleteName.trim()[0]?.toUpperCase() || "A";
  const joinedDate     = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const html = buildWelcomeEmail({ athleteName, athleteSport: displaySport, coachName: displayCoach, initial, joinedDate, signupUrl: SIGNUP_URL });

  const emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from:    FROM_EMAIL,
      to:      [coachEmail.trim().toLowerCase()],
      subject: `${athleteName} just joined WILCO — you're set as their coach`,
      html
    })
  });

  const emailData = await emailRes.json();

  if (!emailRes.ok) {
    return res.status(emailRes.status).json({ error: emailData.message || "Failed to send email" });
  }

  return res.status(200).json({ sent: true, id: emailData.id });
}

// ── Email builder ──────────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function buildWelcomeEmail({ athleteName, athleteSport, coachName, initial, joinedDate, signupUrl }) {
  // Escape user-supplied fields once, up front, so every interpolation below is safe.
  athleteName = esc(athleteName); athleteSport = esc(athleteSport);
  coachName = esc(coachName); initial = esc(initial);
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px">

    <!-- Header -->
    <div style="background:#060d1e;border-radius:12px 12px 0 0;padding:24px 28px;text-align:center">
      <div style="font-size:42px;font-weight:900;color:#d4a017;letter-spacing:6px;line-height:1;font-family:Arial,sans-serif">WILCO</div>
      <div style="color:#64748b;font-size:12px;letter-spacing:4px;margin-top:4px">COACH NOTIFICATION</div>
    </div>

    <!-- Body -->
    <div style="background:#fff;padding:32px 28px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0">

      <p style="color:#1a1a2e;font-size:15px;margin:0 0 16px">Hi ${coachName},</p>
      <p style="color:#444;font-size:14px;line-height:1.7;margin:0 0 24px">
        One of your athletes, <strong>${athleteName}</strong>, just signed up for WILCO — an AI-powered strength and conditioning app that helps high school athletes log workouts, track PRs, and get real-time coaching feedback.
      </p>

      <!-- Athlete card -->
      <div style="background:#f8f9fc;border:1px solid #e0e0e0;border-radius:10px;padding:16px 20px;margin-bottom:24px;display:flex;align-items:center;gap:16px">
        <div style="width:48px;height:48px;border-radius:50%;background:#0a1228;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;color:#d4a017;flex-shrink:0;text-align:center;line-height:48px">
          ${initial}
        </div>
        <div style="margin-left:16px">
          <div style="color:#1a1a2e;font-weight:700;font-size:15px;letter-spacing:0.5px">${athleteName.toUpperCase()}</div>
          <div style="color:#64748b;font-size:12px;margin-top:3px">${athleteSport} &nbsp;·&nbsp; joined ${joinedDate}</div>
        </div>
      </div>

      <!-- What you'll receive -->
      <p style="color:#1a1a2e;font-size:11px;font-weight:700;letter-spacing:1.5px;margin:0 0 14px;text-transform:uppercase">What you'll receive every week</p>

      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;vertical-align:top;width:36px">
            <div style="width:28px;height:28px;border-radius:50%;background:#f0fff4;border:1px solid #27ae60;display:flex;align-items:center;justify-content:center;font-size:13px;text-align:center;line-height:28px">📋</div>
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;vertical-align:top">
            <div style="color:#1a1a2e;font-size:13px;font-weight:600;margin-bottom:3px">Full session log</div>
            <div style="color:#888;font-size:12px;line-height:1.5">Every workout logged that week — date, exercises, sets, reps, and weight.</div>
          </td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;vertical-align:top">
            <div style="width:28px;height:28px;border-radius:50%;background:#f0fff4;border:1px solid #27ae60;display:flex;align-items:center;justify-content:center;font-size:13px;text-align:center;line-height:28px">🏆</div>
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;vertical-align:top">
            <div style="color:#1a1a2e;font-size:13px;font-weight:600;margin-bottom:3px">New PRs</div>
            <div style="color:#888;font-size:12px;line-height:1.5">Automatically flagged when ${athleteName.split(" ")[0]} hits a new personal record on any lift.</div>
          </td>
        </tr>
        <tr>
          <td style="padding:10px 0;vertical-align:top">
            <div style="width:28px;height:28px;border-radius:50%;background:#fff5f5;border:1px solid #e74c3c;display:flex;align-items:center;justify-content:center;font-size:13px;text-align:center;line-height:28px">⚠️</div>
          </td>
          <td style="padding:10px 12px;vertical-align:top">
            <div style="color:#1a1a2e;font-size:13px;font-weight:600;margin-bottom:3px">Pain &amp; injury flags</div>
            <div style="color:#888;font-size:12px;line-height:1.5">If ${athleteName.split(" ")[0]} reports soreness or discomfort, it'll be highlighted in your report.</div>
          </td>
        </tr>
      </table>

      <p style="color:#888;font-size:13px;line-height:1.6;margin:0">
        Reports go out every <strong>Monday morning</strong>. No account needed — they'll arrive right here in your inbox.
      </p>

    </div>

    <!-- CTA -->
    <div style="background:#0a1228;padding:28px;border-radius:0 0 12px 12px;text-align:center">
      <div style="color:#d4a017;font-size:18px;font-weight:700;letter-spacing:1px;margin-bottom:10px">WANT THE FULL DASHBOARD?</div>
      <p style="color:#94a3b8;font-size:13px;line-height:1.7;margin:0 0 18px">
        Set up a coach account to view progress charts, log custom programs,
        and manage all your athletes in one place. No tech setup required.
      </p>
      <a href="${signupUrl}" style="display:inline-block;background:#d4a017;color:#000;font-weight:700;font-size:14px;letter-spacing:1px;padding:13px 32px;border-radius:8px;text-decoration:none">
        SET UP YOUR COACH ACCOUNT →
      </a>
      <p style="color:#475569;font-size:11px;margin:16px 0 0">
        ${athleteName} added you as their coach in WILCO. To stop receiving these emails, reply and let us know.
      </p>
    </div>

  </div>
</body>
</html>`;
}
