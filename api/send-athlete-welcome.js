// Vercel serverless function — sends the athlete their own welcome email right
// after signup. Called from the client's finishOnboarding, fire-and-forget.
//
// WHY THIS EXISTS: PIN recovery (api/send-pin-recovery.js) is the ONLY way back
// into an account, and it depends entirely on an address typed once on a phone
// keyboard and validated with `includes("@")`. A typo'd address is a permanently
// unrecoverable account, discovered at the worst possible moment — locked out,
// months later. Sending one real email on day 1 surfaces a bad address while the
// athlete still remembers their PIN and can fix it in Settings. Deliberately NOT
// a verification gate: no new friction is added to the wizard.
//
// AUTH: the freshly-created athlete's own session, and the recipient is read from
// THEIR OWN DB ROW rather than the request body — so this can never be used to
// send WILCO-branded mail to an arbitrary address (the open-relay reasoning from
// send-coach-welcome, tightened one step further).

import { authCaller, authThrottle, rateLimit, clientIp, sbSelect } from "./_supa.js";

// Vercel Pro: cap execution time. One outbound email; 30s is plenty.
export const maxDuration = 30;

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM_EMAIL = process.env.FROM_EMAIL || "WILCO <noreply@trainwilco.com>";
  const APP_URL = process.env.APP_URL || "https://app.trainwilco.com";
  if (!RESEND_KEY) return res.status(500).json({ error: "Missing RESEND_API_KEY" });

  let caller;
  try {
    const recordAuthFail = await authThrottle(`athlete-welcome-authfail:${clientIp(req)}`);
    try { caller = await authCaller(req.body?.auth); }
    catch (e) { if (e.status === 401) await recordAuthFail(); throw e; }
    if (caller.role !== "athlete") return res.status(403).json({ error: "Not authorized" });
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message || "Unauthorized" });
  }

  // Silent success on throttle — signup UX must never be blocked by this.
  try { await rateLimit(`athlete-welcome:${clientIp(req)}`, { max: 10, windowMin: 60 }); }
  catch { return res.status(200).json({ ok: true, skipped: "rate_limited" }); }

  // Recipient comes from the caller's OWN row, never the request body.
  const rows = await sbSelect("athletes", `?id=eq.${encodeURIComponent(caller.id)}&select=name,email`);
  const me = rows[0];
  if (!me?.email) return res.status(200).json({ ok: true, skipped: "no_email" });

  const first = String(me.name || "").split(" ")[0] || "there";
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  <div style="background:#060d1e;border-radius:12px 12px 0 0;padding:26px 28px;text-align:center">
    <div style="font-size:40px;font-weight:900;color:#3a7bff;letter-spacing:6px">WILCO</div>
    <div style="color:#64748b;font-size:11px;letter-spacing:4px;margin-top:4px">YOUR ACCOUNT IS LIVE</div>
  </div>
  <div style="background:#fff;padding:28px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0">
    <p style="font-size:16px;margin:0 0 16px;color:#1a1a2e">Welcome, ${esc(first)}.</p>
    <p style="font-size:14px;line-height:1.7;color:#333;margin:0 0 16px">
      You're set up and Coach Joe is ready. Tell him what you trained and he'll log it, track your maxes, and adjust your program as you go.
    </p>
    <div style="background:#f7f9ff;border-left:3px solid #3a7bff;padding:12px 14px;margin:0 0 18px;border-radius:0 6px 6px 0">
      <strong style="color:#1a1a2e;font-size:13px">Keep this email</strong>
      <p style="margin:6px 0 0;font-size:13px;line-height:1.6;color:#444">
        This is the address we use to get you back in if you ever forget your PIN. If it's wrong, fix it now in Settings &rarr; My Coach while you still remember it.
      </p>
    </div>
    <div style="text-align:center;margin-top:22px">
      <a href="${APP_URL}" style="display:inline-block;background:#3a7bff;color:#fff;font-weight:700;font-size:13px;letter-spacing:1px;padding:12px 28px;border-radius:8px;text-decoration:none">START TRAINING &rarr;</a>
    </div>
  </div>
  <div style="background:#060d1e;border-radius:0 0 12px 12px;padding:16px 28px;text-align:center">
    <p style="color:#475569;font-size:11px;margin:0">WILCO &middot; Your proof is in the work.</p>
  </div>
</div></body></html>`;

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: [me.email], subject: "Welcome to WILCO — your account is live", html }),
    });
  } catch (e) {
    console.error("[athlete-welcome] send failed:", e.message);
  }
  return res.status(200).json({ ok: true });
}
