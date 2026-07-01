// Vercel serverless function — sends a coach their WILCO access code when onboarded by admin.
// Called from the master dashboard school onboarding form.
//
// AUTH: master/admin coaches only. This endpoint renders caller-supplied text into
// a WILCO-branded email and sends it to a caller-supplied address, so without a
// gate it was an open relay (arbitrary phishing from our domain + Resend quota
// burn). Coach creation itself is already master/admin-only via the write gateway;
// this makes the notify step prove the same before any mail goes out.

import { authCaller, sbSelect, authThrottle, clientIp } from "./_supa.js";

const enc = encodeURIComponent;
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM_EMAIL = process.env.FROM_EMAIL || "WILCO <reports@wilco.app>";
  const APP_URL    = process.env.APP_URL || "https://app.trainwilco.com";

  if (!RESEND_KEY) return res.status(500).json({ error: "Missing RESEND_API_KEY" });

  const { auth, coachName, coachEmail, accessCode, schoolName } = req.body || {};

  // Require a master/admin coach session. Brute-force-guard the PIN fallback path.
  try {
    const recordAuthFail = await authThrottle(`coach-invite-authfail:${clientIp(req)}`);
    let caller;
    try { caller = await authCaller(auth); }
    catch (e) { if (e.status === 401) await recordAuthFail(); throw e; }
    if (caller.role !== "coach") return res.status(403).json({ error: "Not authorized" });
    const me = (await sbSelect("coaches", `?id=eq.${enc(caller.id)}&select=role`))[0];
    if (!me || (me.role !== "master" && me.role !== "admin")) {
      return res.status(403).json({ error: "Not authorized" });
    }
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message || "Unauthorized" });
  }

  if (!coachEmail)  return res.status(400).json({ error: "coachEmail is required" });
  if (!accessCode)  return res.status(400).json({ error: "accessCode is required" });

  const displayCoach  = coachName  || "Coach";
  const displaySchool = schoolName || "your school";

  const html = buildInviteEmail({ coachName: displayCoach, coachEmail, accessCode, schoolName: displaySchool, appUrl: APP_URL });

  const emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from:    FROM_EMAIL,
      to:      [coachEmail.trim().toLowerCase()],
      subject: `Your WILCO coach access code — ${accessCode}`,
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
function buildInviteEmail({ coachName, accessCode, schoolName, appUrl }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px">

    <!-- Header -->
    <div style="background:#060d1e;border-radius:12px 12px 0 0;padding:24px 28px;text-align:center">
      <div style="font-size:42px;font-weight:900;color:#d4a017;letter-spacing:6px;line-height:1;font-family:Arial,sans-serif">WILCO</div>
      <div style="color:#64748b;font-size:12px;letter-spacing:4px;margin-top:4px">COACH INVITE</div>
    </div>

    <!-- Body -->
    <div style="background:#fff;padding:32px 28px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0">

      <p style="color:#1a1a2e;font-size:15px;margin:0 0 16px">Hi ${esc(coachName)},</p>
      <p style="color:#444;font-size:14px;line-height:1.7;margin:0 0 24px">
        You've been added as a coach for <strong>${esc(schoolName)}</strong> on WILCO — an AI-powered strength and conditioning platform for high school athletes.
      </p>
      <p style="color:#444;font-size:14px;line-height:1.7;margin:0 0 24px">
        Your athletes will use your access code to register and get automatically assigned to your dashboard. Here it is:
      </p>

      <!-- Access code card -->
      <div style="background:#060d1e;border-radius:12px;padding:24px;text-align:center;margin-bottom:28px">
        <div style="color:#64748b;font-size:11px;letter-spacing:3px;margin-bottom:10px">YOUR ACCESS CODE</div>
        <div style="color:#d4a017;font-size:40px;font-weight:900;letter-spacing:12px;font-family:Arial,sans-serif">${esc(accessCode)}</div>
        <div style="color:#475569;font-size:12px;margin-top:12px;line-height:1.6">
          Share this code with your athletes — they'll enter it when signing up.<br/>
          <strong style="color:#94a3b8">Keep it safe. Each code is unique to you.</strong>
        </div>
      </div>

      <!-- Steps -->
      <p style="color:#1a1a2e;font-size:11px;font-weight:700;letter-spacing:1.5px;margin:0 0 14px;text-transform:uppercase">Getting started — 2 steps</p>

      <table style="width:100%;border-collapse:collapse;margin-bottom:28px">
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #f0f0f0;vertical-align:top;width:40px">
            <div style="width:28px;height:28px;border-radius:50%;background:#d4a017;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#000;text-align:center;line-height:28px">1</div>
          </td>
          <td style="padding:12px 0 12px 14px;border-bottom:1px solid #f0f0f0;vertical-align:top">
            <div style="color:#1a1a2e;font-size:13px;font-weight:600;margin-bottom:3px">Open WILCO and tap "First time coach? Enter access code"</div>
            <div style="color:#888;font-size:12px;line-height:1.5">Enter your code above and create a 4-digit PIN. You're in.</div>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 0;vertical-align:top">
            <div style="width:28px;height:28px;border-radius:50%;background:#d4a017;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#000;text-align:center;line-height:28px">2</div>
          </td>
          <td style="padding:12px 0 0 14px;vertical-align:top">
            <div style="color:#1a1a2e;font-size:13px;font-weight:600;margin-bottom:3px">Share your code with your athletes</div>
            <div style="color:#888;font-size:12px;line-height:1.5">When they sign up, they enter <strong>${esc(accessCode)}</strong> and land directly on your roster.</div>
          </td>
        </tr>
      </table>

    </div>

    <!-- CTA -->
    <div style="background:#0a1228;padding:28px;border-radius:0 0 12px 12px;text-align:center">
      <a href="${appUrl}" style="display:inline-block;background:#d4a017;color:#000;font-weight:700;font-size:14px;letter-spacing:1px;padding:13px 32px;border-radius:8px;text-decoration:none">
        OPEN WILCO &amp; SET UP YOUR DASHBOARD →
      </a>
      <p style="color:#475569;font-size:11px;margin:16px 0 0">
        Questions? Email us at coachjoe@trainwilco.com
      </p>
    </div>

  </div>
</body>
</html>`;
}
