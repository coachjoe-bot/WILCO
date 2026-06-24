// ─── RETIRED ──────────────────────────────────────────────────────────────────
// This edge function used to forward any request body to api.anthropic.com gated
// only by the PUBLIC Supabase anon key — an open Anthropic billing proxy. It has
// been replaced by the authenticated Vercel function `api/claude.js`, which
// requires a logged-in athlete/coach, rate-limits per user, allowlists the model,
// and caps max_tokens.
//
// The DEPLOYED copy of this function must be DELETED in the Supabase dashboard
// (Edge Functions → claude-proxy → Delete); editing this file does not undeploy it.
// This inert stub exists only so an accidental redeploy can't reopen the hole.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(() =>
  new Response(
    JSON.stringify({ error: "This endpoint has been retired. Use /api/claude." }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  )
);
