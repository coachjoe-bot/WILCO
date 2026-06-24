// Vercel serverless function — PIN reset by email.
// PINs are stored as bcrypt hashes and cannot be read back, so "recovery" issues a
// NEW random PIN, stores its hash, and emails the new PIN to the account's address.
// Works for athletes (matched by name + email) and coaches (matched by email).
// Always returns a generic success response to prevent account enumeration.

import bcrypt from "bcryptjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const RESEND_KEY   = process.env.RESEND_API_KEY;
  const FROM_EMAIL   = process.env.FROM_EMAIL || "WILCO <noreply@trainwilco.com>";
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  // Must be the SERVICE key — athletes/coaches reads are RLS-protected from the anon key.
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_KEY;

  if (!RESEND_KEY)    return res.status(500).json({ error: "Missing RESEND_API_KEY" });
  if (!SUPABASE_URL)  return res.status(500).json({ error: "Missing SUPABASE_URL" });
  if (!SUPABASE_KEY)  return res.status(500).json({ error: "Missing SUPABASE_KEY" });

  const { type, name, email } = req.body || {};

  if (!email) return res.status(400).json({ error: "email is required" });
  if (!type)  return res.status(400).json({ error: "type is required (athlete or coach)" });

  const sbHeaders = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
  };

  try {
    let displayName = "";
    let target = null; // { table, id } of the matched account

    if (type === "athlete") {
      if (!name) return res.status(400).json({ error: "name is required for athlete recovery" });

      const url = `${SUPABASE_URL}/rest/v1/athletes?name=ilike.${encodeURIComponent(name.trim())}&email=eq.${encodeURIComponent(email.trim().toLowerCase())}&select=id,name`;
      const r = await fetch(url, { headers: sbHeaders });
      const rows = await r.json();

      if (Array.isArray(rows) && rows.length > 0) {
        target = { table: "athletes", id: rows[0].id };
        displayName = rows[0].name;
      }

    } else if (type === "coach") {
      const url = `${SUPABASE_URL}/rest/v1/coaches?email=eq.${encodeURIComponent(email.trim().toLowerCase())}&select=id,name`;
      const r = await fetch(url, { headers: sbHeaders });
      const rows = await r.json();

      if (Array.isArray(rows) && rows.length > 0) {
        target = { table: "coaches", id: rows[0].id };
        displayName = rows[0].name || "Coach";
      }
    }

    // Hashed PINs can't be read back — reset to a new random 4-digit PIN and email it.
    let newPin = null;
    if (target) {
      newPin = String(Math.floor(1000 + Math.random() * 9000));
      const hash = await bcrypt.hash(newPin, 10);
      await fetch(`${SUPABASE_URL}/rest/v1/${target.table}?id=eq.${target.id}`, {
        method: "PATCH",
        headers: { ...sbHeaders, Prefer: "return=minimal" },
        body: JSON.stringify({ pin: hash }),
      });
    }

    // Always return 200 regardless of whether we found an account (prevents enumeration)
    if (newPin) {
      const html = buildPinEmail({ displayName, pin: newPin, type });

      const subject = type === "coach"
        ? "Your new WILCO Coach PIN"
        : "Your new WILCO PIN";

      console.log("[pin-recovery] sending to:", email, "| from:", FROM_EMAIL, "| has_resend_key:", !!RESEND_KEY, "| has_supabase:", !!SUPABASE_URL);
      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [email.trim().toLowerCase()],
          subject,
          html,
        }),
      });
      const resendData = await resendRes.json();
      console.log("[pin-recovery] resend response:", JSON.stringify(resendData));
    }

    return res.status(200).json({ sent: true });

  } catch (e) {
    console.error("send-pin-recovery error:", e);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ── Email builder ──────────────────────────────────────────────────────────────
function buildPinEmail({ displayName, pin, type }) {
  const greeting = displayName ? `Hi ${displayName},` : "Hi,";
  const roleLabel = type === "coach" ? "coach" : "athlete";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:480px;margin:0 auto;padding:24px 16px">

    <!-- Header -->
    <div style="background:#060d1e;border-radius:12px 12px 0 0;padding:24px 28px;text-align:center">
      <div style="font-size:42px;font-weight:900;color:#d4a017;letter-spacing:6px;line-height:1;font-family:Arial,sans-serif">WILCO</div>
      <div style="color:#64748b;font-size:12px;letter-spacing:4px;margin-top:4px">PIN RECOVERY</div>
    </div>

    <!-- Body -->
    <div style="background:#fff;padding:32px 28px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0">
      <p style="color:#1a1a2e;font-size:15px;margin:0 0 16px">${greeting}</p>
      <p style="color:#444;font-size:14px;line-height:1.7;margin:0 0 24px">
        You requested a PIN reset. Your new WILCO ${roleLabel} PIN is:
      </p>

      <!-- PIN display -->
      <div style="background:#f8f9fc;border:2px solid #d4a017;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
        <div style="color:#64748b;font-size:11px;letter-spacing:2px;margin-bottom:8px;text-transform:uppercase">Your PIN</div>
        <div style="font-size:48px;font-weight:900;color:#060d1e;letter-spacing:16px;font-family:monospace">${pin}</div>
      </div>

      <p style="color:#888;font-size:13px;line-height:1.6;margin:0 0 16px">
        Keep this somewhere safe. If you didn't request this reset, contact us right away — your PIN was just changed.
      </p>
      <p style="color:#888;font-size:13px;line-height:1.6;margin:0">
        Questions? Email us at <a href="mailto:joe.thomas@commandengineering.com" style="color:#d4a017">joe.thomas@commandengineering.com</a>.
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#0a1228;padding:16px 28px;border-radius:0 0 12px 12px;text-align:center">
      <p style="color:#475569;font-size:11px;margin:0">
        This email was sent because a PIN recovery was requested for your WILCO account.
      </p>
    </div>

  </div>
</body>
</html>`;
}
