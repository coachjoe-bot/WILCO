// ─── AUTHENTICATED WRITE GATEWAY ──────────────────────────────────────────────
// All app writes route through here so the database can deny the public (anon)
// key entirely. The caller proves identity (athlete or coach id + PIN); the write
// itself runs server-side with the service key.
//
// POST { auth:{role,id,pin}, op:"insert"|"update"|"delete"|"upsert", table, data?, id?, params?, conflict? }
//
// Phase 1   closed the ANONYMOUS write hole (a valid logged-in caller is required).
// Phase 1b  adds per-row OWNERSHIP scoping for ATHLETE callers: an athlete may only
//           write rows they own (athlete_id == their id, or the athletes row whose
//           id == their id) and only the athlete-owned tables. Enforced two ways:
//           (1) insert/upsert payloads must carry the caller's own id in the
//               ownership column (every row);
//           (2) update/delete queries get an extra "&<col>=eq.<callerId>" filter
//               appended, so a stray/forged client filter can only ever match the
//               caller's own rows — PostgREST ANDs repeated column filters, so a
//               mismatched id matches zero rows (a silent no-op, not a cross-write).
//
// COACH-role writes ARE now per-row scoped too (see the "Coach write scoping" block):
//       master → all; admin → their school; regular coach → their own roster only.
//       schools are master-only, and coaches-table writes are admin-only (own school).

import { applyCors, httpErr, str, sbWrite, sbSelect, authCaller, tryTokenAuth, logError, authThrottle, clientIp } from "./_supa.js";
import { toLbs as toLbsShared } from "./_units.js";
import { CREW_ENABLED } from "./_flags.js";
import { crewPeerIds, resolveCrewOrg, crewAllowedFor, composeGoalGlance, goalTargets, bestE1rmLbsForLift, orderedPair, withinWindow, withinTierPct, compareStateFor, CREW_CAP, REACTION_EMOJI, CREW_CODE_ALPHABET } from "./_crew.js";

const enc = encodeURIComponent;

// Coach alert sender, imported LAZILY: ./_push.js pulls in web-push (~34ms of
// module init), and this is the app's hottest route — every write and every
// scoped read lands here, while a coach alert fires only on the rare workout
// row carrying pain flags or a genuinely-improved PR. Loading it on demand
// keeps that cost off the cold start of the other 99% of calls.
const notifyCoachLazy = async (...args) => {
  const { notifyCoach } = await import("./_push.js");
  return notifyCoach(...args);
};

// Tables the app legitimately writes. Anything else is rejected outright.
const WRITABLE = new Set([
  "athletes", "workouts", "prs", "coaches", "schools",
  "manual_one_rms", "program_modifications", "athlete_goals",
  "legal_acceptances", "deletion_requests", "athlete_context",
  "push_subscriptions", "proof_digests",
  // Coach dashboard overhaul: the coach's own self-service data + the locked-program
  // request loop. Scoping enforced below (coach_context/coach_push_subscriptions =
  // own coach_id; program_change_requests = athlete inserts own, coach updates status).
  "coach_context", "coach_push_subscriptions", "program_change_requests",
  // Saved Programs library (G8). Coach-owned; scoping is coach_id, same as coach_context.
  "coach_programs",
  // T53: typed training preferences — athlete-owned, enum-pinned below.
  "athlete_training_prefs",
  // Parsed-program cache: the coach dashboard parses missing/stale programs on
  // demand (Haiku via api/claude.js, hash-keyed) and upserts the result here —
  // same row shape parseProgramIfNeeded writes on the proof cron. Ownership-scoped
  // like the raw athlete tables.
  "program_prescriptions",
  // Program Builder Phase B: parked interviews / finished drafts, and the
  // block-history snapshot written on every program_text save (see
  // src/programHistory.js). RLS-on/zero-policy tables reached only through here.
  "program_drafts", "program_history",
  // WILCO Crew V1. crew_moments gets a plain ATHLETE_OWN_COL entry below (a
  // moment is just an athlete-owned insert, same trust level as workouts/prs).
  // crew_edges/crew_reactions deliberately have NO ATHLETE_OWN_COL entry, which
  // closes the GENERIC insert/update/delete/upsert path for them (both athlete
  // and coach callers 403 there, same as any table missing from that map) — all
  // real edge/reaction writes go through the dedicated `crew` op (below), whose
  // per-action authz (peer checks, the 10-cap, canonical pair ordering, the
  // reaction emoji allowlist, the org-comparison ban) IS the security boundary
  // for those two, and can never be bypassed by a client crafting a raw
  // insert/update/delete against them.
  "crew_edges", "crew_moments", "crew_reactions",
  // T58 mastermind memory: per-athlete durable facts (the row-per-fact successor
  // to the athlete_context blob). Athlete-owned; kind/status enum-pinned below.
  "athlete_memory",
]);

// ─── Phase 1b(b): scoped READS ────────────────────────────────────────────────
// Tables the app reads through this gateway with per-row OWNERSHIP scoping, so we
// can deny the anon key SELECT on them (they hold athletes' — incl. minors' — PII).
// Each maps to the column that identifies the owning athlete. The server forces an
// ownership filter onto every read; the client's own filters are ANDed on top
// (PostgREST ANDs repeated column filters), so a forged client filter can only ever
// NARROW to rows the caller already owns — never widen.
const READ_OWN_COL = {
  workouts: "athlete_id",
  prs: "athlete_id",
  proof_digests: "athlete_id",
  manual_one_rms: "athlete_id",
  athlete_goals: "athlete_id",
  athlete_context: "athlete_id",
  // Parsed structured program cache (Haiku-parsed program_text, hash-keyed). Read-
  // only for the coach dashboard's Overview adherence math (load %×1RM band). Scoped
  // by athlete_id exactly like the raw tables, so a coach only sees their roster's
  // prescriptions. Written by the proof cron (service key) AND by the coach
  // dashboard's on-demand parse (gateway upsert, ownership-scoped).
  program_prescriptions: "athlete_id",
  // Server-side session-count rollup (SQL port of groupIntoSessions, verified to
  // match the client row-for-row). Read-only VIEW; scoped by athlete_id exactly
  // like the raw tables, so a coach only sees their own roster's counts. Lets the
  // coach dashboard show session totals without pulling every raw workout to the
  // browser (see docs/coach-experience-roadmap.md for the dashboard wiring).
  v_athlete_session_counts: "athlete_id",
  // Coach overhaul. coach_context + coach_push_subscriptions are the coach's OWN
  // rows (coach_id); program_change_requests is read by the ATHLETE by athlete_id
  // (their own filed requests) and by the COACH by coach_id (their inbox — the coach
  // branch below overrides the scope column to coach_id).
  coach_context: "coach_id",
  coach_push_subscriptions: "coach_id",
  program_change_requests: "athlete_id",
  // Program Builder Phase B. Athletes read their own drafts/history by athlete_id;
  // coach reads of program_drafts are overridden to coach_id below (their OWN
  // drafts — a coach's in-progress work isn't the athlete's to browse, and
  // team-level drafts have a NULL athlete_id that roster scoping would drop).
  // program_history is athlete data proper: roster-scoped for coaches like workouts.
  program_drafts: "athlete_id",
  program_history: "athlete_id",
  // Saved Programs library (G8): the coach's OWN rows, like coach_context. An
  // athlete caller's forced scope (coach_id = their athlete id) matches nothing.
  // NOTE this list is a FOURTH registration point beyond the three the G8 commit
  // named — reads die loudly ("Table not readable") without it while writes land.
  coach_programs: "coach_id",
  // The program-change strip on the Program tab ("why does my program say 315
  // now?"). Written on PR propagation / correction reversal / Field Mode; the
  // gateway hardening dropped its read and the strip died silently on every
  // Program-modal open (T57 — found via a 400 in the live walk).
  program_modifications: "athlete_id",
  // T53: typed training preferences (athlete reads own; coach reads roster's).
  athlete_training_prefs: "athlete_id",
  // T58 mastermind memory (athlete reads own; coach reads roster's, same trust
  // as athlete_context — memory is athlete-visible by design).
  athlete_memory: "athlete_id",
};

// Tables read/written by COACH callers scoped to their OWN coach_id (not their
// roster's athlete_ids) — the coach's own data + the aggregate/inbox rows.
const COACH_SELF_SCOPED = new Set([
  "proof_digests", "coach_context", "coach_push_subscriptions", "program_change_requests",
  "program_drafts", "coach_programs",
]);

// Tables an ATHLETE caller may write, each mapped to the column that must equal
// their own id. Any table NOT listed here is denied outright for athlete callers.
const ATHLETE_OWN_COL = {
  athletes: "id",
  workouts: "athlete_id",
  prs: "athlete_id",
  manual_one_rms: "athlete_id",
  athlete_goals: "athlete_id",
  program_modifications: "athlete_id",
  athlete_context: "athlete_id",
  athlete_memory: "athlete_id",
  push_subscriptions: "athlete_id",
  proof_digests: "athlete_id",
  legal_acceptances: "athlete_id",
  deletion_requests: "athlete_id",
  // An athlete may FILE a program-change request on their own locked program.
  program_change_requests: "athlete_id",
  // Parse-cache rows (see WRITABLE note). Listing here scopes COACH writes to their
  // roster; it also permits an athlete to (re)write their OWN row — same trust as
  // them writing the workouts that feed the same adherence math.
  program_prescriptions: "athlete_id",
  // Program Builder Phase B: an athlete owns their drafts and their block history.
  // Column-level limits below pin what they may set (owner_type is forced to
  // 'athlete', status/scope/source to their enums).
  program_drafts: "athlete_id",
  program_history: "athlete_id",
  // WILCO Crew V1. crew_moments is a plain athlete-owned insert (same trust level
  // as workouts/prs — the client decides WHEN a moment is worth writing; the
  // gateway just proves the row belongs to the caller). Deliberately NOT
  // crew_edges/crew_reactions — those need real server-side business logic
  // (request/accept cap, canonical pair ordering, the reaction toggle + emoji
  // allowlist) that a plain ownership-scoped insert can't express, so those two
  // are handled ONLY by the dedicated `crew` op above and stay unreachable here
  // (no entry below → the generic path 403s them, see the WRITABLE comment).
  crew_moments: "athlete_id",
  // T53: typed training preferences — column/value-pinned in ATHLETE_COL_ALLOW.
  athlete_training_prefs: "athlete_id",
};

// ── Per-COLUMN allowlist for athlete writes to sensitive tables ───────────────
// Row-ownership scoping (above) stops an athlete writing ANOTHER account's row, but
// not WHICH COLUMNS they set on their OWN row. `athletes` holds coach/billing/role
// fields an athlete must never self-set — tier escalation, program_locked, role,
// pin, stripe ids. For any table listed here, every key in the write payload must be
// allowlisted or the write is rejected: a hard server-side boundary independent of
// what the client (or an AI extractor parsing free-text chat) sends. Columns NOT
// listed are denied; tables not in this map keep plain row-only scoping.
const ATHLETE_COL_ALLOW = {
  // T58 mastermind memory: the model writes these through tool handlers, so pin
  // the vocabulary server-side — content bounded, kind/status enums, expires_at
  // must parse. (athlete_id is forced by ATHLETE_OWN_COL ownership above.)
  athlete_memory: {
    cols: new Set(["content", "kind", "expires_at", "source", "status", "updated_at"]),
    values: {
      // T61 (Will 08-29): 2000 is the abuse bound, not a product cap — the
      // injected block is token-budgeted in src/memory.js. DB CHECK twin:
      // migration 20260829_athlete_memory_content_2000 (constraint and this
      // pin must move together — the recs-wave trap).
      content: (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 2000,
      kind: (v) => ["pinned", "contextual", "situational"].includes(v),
      source: (v) => ["athlete_said", "inferred"].includes(v),
      status: (v) => ["active", "deleted"].includes(v),
      expires_at: (v) => v == null || Number.isFinite(Date.parse(v)),
    },
  },
  athletes: {
    cols: new Set([
      // profile / onboarding (set during signup + profile completion)
      "goal", "coach_name", "coach_email", "coach_id", "school_id",
      "birthday", "age", "height_inches", "gender", "training_days_per_week",
      "equipment", "position_or_event", "injury_history", "recruiting_intent",
      // self-service settings + app-maintained state
      "weight_lbs", "weight_unit", "height_finalized", "ask_weight",
      "program_text", "temp_program_text", "first_chat_complete", "resolved_pain",
      // Program position: the athlete's own "I'm on week 2 day 3" claim and their
      // answer to "does this block end?". Added 2026-08-05 (T32e): these columns
      // shipped with the 07-27 position feature AFTER this allowlist existed, so
      // every claim write was silently rejected here for 8 days — the parse
      // succeeded, in-memory state updated, and the next session forgot. When a
      // new athlete-writable column ships, it MUST be added here or the write
      // dies silently behind the client's catch.
      "program_position_override", "program_block_span",
      "proof_enabled", "proof_schedule_dow", "proof_schedule_hour", "proof_timezone",
      // gamification counters the app maintains as the athlete logs sessions
      "total_sessions_logged", "certified_badge_earned_at",
      "tier",
      // onboarding tour resolution stamp (taken or declined — either way it's done)
      "tour_done_at",
      // T57-B: recovery email, self-serve add/fix — 29 of 53 athletes signed up
      // name-only and could never PIN-recover. Format-guarded in `values`.
      "email",
    ]),
    // Value guards: an athlete may only ever DOWNGRADE their own tier to "free"
    // (paid tiers are granted server-side by Stripe), never self-grant pro/elite.
    values: {
      tier: (v) => v === "free",
      email: (v) => typeof v === "string" && /^\S+@\S+\.\S+$/.test(v.trim()) && v.trim().length <= 200,
    },
  },
  // A filed request is AI-extracted from free-text chat — pin down what the athlete
  // side may set so it can never self-resolve (status) or misroute. status defaults
  // to 'pending' in the DB; only the coach flips it (coach write path below).
  program_change_requests: {
    cols: new Set(["coach_id", "items", "reason", "source"]),
    // "builder" = the Phase D coach summary card: an unlocked athlete saved a
    // Builder program; the coach gets a distinct inbox card (not a change ask).
    values: { source: (v) => ["plateau", "pr", "pain", "feedback", "builder"].includes(v) },
  },
  // Program Builder Phase B. An athlete's draft is always their OWN (owner_type
  // pinned to 'athlete', never coach_id-bearing), and status/scope stay inside
  // the vocab the Drafts tab renders.
  program_drafts: {
    cols: new Set([
      "owner_type", "title", "status", "blueprint", "transcript",
      "draft_text", "provisional_goal", "scope", "updated_at",
      // T64 Fix 3: non-destructive card hide. dismissed_at is a stamp, never a
      // status — the row, its blueprint.rec.swaps, and any auto-revert clock
      // stay exactly as they were. Additive column (20260928_program_drafts_
      // dismissed_at.sql), applied to prod 2026-09-28.
      "dismissed_at",
    ]),
    values: {
      owner_type: (v) => v === "athlete",
      // rec / rec_applied: staged Program Recs (Will's 08-28 design) ride the
      // same rows as Builder drafts — the payload lives in blueprint.rec.
      // Dismissing a rec DELETES the row (Will 09-01), so no dismissed status
      // exists app-side; the DB CHECK still tolerates 'rec_dismissed' from the
      // 20260831 migration (inert, nothing writes it). TWIN: the DB CHECK
      // constraint program_drafts_status_check and this enum are separate
      // gates — BOTH must know every status the app writes.
      status: (v) => ["interview", "draft", "applied", "rec", "rec_applied"].includes(v),
      scope: (v) => ["full", "short", "quick"].includes(v),
      // T64 Fix 3: null clears a dismiss (not currently used by the client, but
      // keeps the validator symmetric with every other timestamp column here).
      dismissed_at: (v) => v === null || (typeof v === "string" && !Number.isNaN(Date.parse(v))),
    },
  },
  // T53: typed training preferences. The payload originates from an AI extraction
  // of free-text chat, so both columns and VALUES are pinned to the enums — a
  // sentence can carry an injection, an enum can't. Caps are integers in range.
  athlete_training_prefs: {
    cols: new Set([
      "loading_language", "max_update_policy", "testing_style",
      "session_minutes_cap", "movements_per_day_cap", "accessory_load",
      "source", "confirmed_at", "updated_at", "signals",
    ]),
    values: {
      loading_language: (v) => ["percent+rpe", "percent", "rpe", "climb_singles", "fixed_weight"].includes(v),
      max_update_policy: (v) => ["infer", "declared_only", "pr_single_only"].includes(v),
      testing_style: (v) => ["final_week", "test_day", "retest_cycle"].includes(v),
      accessory_load: (v) => ["programmed", "athlete_choice"].includes(v),
      source: (v) => ["chat", "builder", "settings", "auto"].includes(v),
      session_minutes_cap: (v) => v == null || (Number.isInteger(v) && v >= 15 && v <= 240),
      movements_per_day_cap: (v) => v == null || (Number.isInteger(v) && v >= 2 && v <= 15),
    },
  },
  // Block-history snapshots (src/programHistory.js). source names the save path
  // that opened the block; the vocab is closed so free-text chat extraction can
  // never invent one.
  program_history: {
    // applied_at was missing from this set at launch, which 403'd EVERY
    // athlete-side snapshot insert (snapshotProgramHistory sends it explicitly)
    // and left program_history empty on prod. Guard the value, allow the column.
    cols: new Set([
      "program_text", "source", "block_summary", "block_recap", "block_name", "completed_at", "applied_at", "ends_at",
      // T64 Fix 3b: short athlete-facing recap alongside the full AI-context
      // one. Additive column (20260928_program_history_block_recap_short.sql),
      // NOT yet applied to prod — this entry is listed here (ship-dark safe:
      // an unapplied column is simply an unused allowlist entry) so the write
      // works the instant the integrator applies the migration, with no second
      // deploy needed. Until then, closeBlock's own try/catch absorbs the
      // "unknown column" failure.
      "block_recap_short",
    ]),
    values: {
      source: (v) => [
        "manual_edit", "chat_save", "chat_replace", "chat_append", "chat_create",
        "self_change", "checkin_change", "pr_propagation", "correction_reversal",
        "builder", "coach_save", "next_block", "backfill", "goal_change",
      ].includes(v),
      applied_at: (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)),
      ends_at: (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)),
      block_recap_short: (v) => v === null || (typeof v === "string" && v.length <= 400),
      block_name: (v) => v === null || (typeof v === "string" && v.length <= 80),
    },
  },
};

// PIN hashes must never ride back out of this gateway. Writes to `athletes` /
// `coaches` use PostgREST's return=representation, so the PATCH/POST response
// carried the caller's own bcrypt hash to the browser. It is only ever their own
// row (ownFilter scopes every write), but a bcrypt hash of a FOUR-DIGIT pin is a
// 10,000-candidate offline crack, so it does not belong in a response body,
// a devtools tab, or anything that logs one. identity.js has always stripped it
// (stripPin); this is the same rule on the write path.
export const stripPins = (json) => {
  if (Array.isArray(json)) return json.map(stripPins);
  if (json && typeof json === "object" && "pin" in json) { const { pin, ...rest } = json; return rest; }
  return json;
};

// Vercel Pro: cap this function's execution time. Was implicitly the Hobby 10s
// wall; 20s gives external Stripe/email/DB calls room without paying for idle time.
export const maxDuration = 20;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  body = body || {};

  let caller = null;
  try {
    // Fast path: a valid signed session token authenticates with zero DB work —
    // no throttle lookup, no bcrypt. Tokens aren't brute-forceable (HMAC over a
    // 256-bit key, vs a 4-digit PIN space), so the throttle isn't needed here.
    caller = tryTokenAuth(body.auth);
    if (!caller) {
      // Brute-force guard: refuse once an IP has too many recent failed PIN attempts,
      // and record THIS attempt only if it fails (legit callers send the right PIN and
      // are never throttled). Must run before authCaller so a locked IP skips bcrypt.
      const recordAuthFail = await authThrottle(`data-authfail:${clientIp(req)}`);
      try {
        caller = await authCaller(body.auth);
      } catch (e) {
        if (e.status === 401) await recordAuthFail();
        throw e;
      }
    }

    // ── WILCO Crew V1: peer-scoped op ────────────────────────────────────────
    // Routed here (same spot as the "read" special case below, before the
    // generic WRITABLE table check) because crew reads/writes need a peer set
    // resolved BEFORE the row filter is known — exactly like the coach non-
    // master read-scoping block just below ("look up my athletes, then filter
    // by that id set"), and because accepting a request/removing a member/
    // reacting are none of insert/update/delete/upsert in the generic sense
    // (they flip status based on which side you are, or toggle a row). See
    // api/_crew.js for the shared peer-resolution helper and api/push.js for
    // the action-dispatch pattern this mirrors.
    if (body.op === "crew") {
      // Crew is PARKED (Will, 08-20). Refusing here — not just hiding the tab —
      // means stale cached bundles can't act on crew either. Data stays intact;
      // flipping CREW_ENABLED revives the whole op family untouched.
      if (!CREW_ENABLED) return res.status(403).json({ error: "Crew isn't available right now." });
      return await handleCrew(body, caller, res);
    }

    // ── Phase 1b(b): scoped READ ─────────────────────────────────────────────
    // Routed here so the anon key can be denied SELECT on these PII tables. The
    // server forces an ownership scope; athletes see only their own rows, coaches
    // see only their athletes' rows (master sees all — mirrors coach-dashboard).
    if (body.op === "read") {
      const rtable = String(body.table || "");
      const col = READ_OWN_COL[rtable];
      if (!col) throw httpErr(400, `Table not readable: ${rtable}`);

      let scope = "";
      if (caller.role === "athlete") {
        scope = `&${col}=eq.${enc(caller.id)}`;
        // A coach's in-progress draft ABOUT an athlete carries the same athlete_id
        // but may hold the coach's candid notes (team read, roster spread). The
        // athlete sees only their OWN drafts; the coach's stay coach-private.
        if (rtable === "program_drafts") scope += "&owner_type=eq.athlete";
      } else if (caller.role === "coach") {
        // The DB role (master/admin/regular) is the source of truth for breadth —
        // authCaller only proves the caller IS a coach, not which kind.
        const me = (await sbSelect("coaches", `?id=eq.${enc(caller.id)}&select=id,role`))[0];
        if (!me) throw httpErr(401, "Not authorized");
        if (me.role !== "master") {
          // proof_digests carry the owning coach_id on BOTH per-athlete digests and
          // the team-aggregate coach reports (weekly_coach/monthly_coach, which have
          // a NULL athlete_id). Scope those by coach_id so a coach gets their whole
          // report set — athlete-id membership would drop the aggregate rows.
          if (COACH_SELF_SCOPED.has(rtable)) {
            // The coach's own aggregate/inbox/context rows carry coach_id directly —
            // scope by it (athlete-id membership would drop coach-owned rows).
            scope = `&coach_id=eq.${enc(caller.id)}`;
          } else {
            // Other PII tables: non-master coaches (incl. admins) see only their own
            // athletes' rows — the set coach-dashboard returns and the client filtered to.
            const aths = await sbSelect("athletes", `?coach_id=eq.${enc(caller.id)}&select=id`);
            const ids = aths.map((a) => a.id);
            if (ids.length === 0) return res.status(200).json([]);
            scope = `&${col}=in.(${ids.map((id) => `"${id}"`).join(",")})`;
          }
        }
        // master: no scope → all rows.
      } else {
        throw httpErr(403, "This account can't read that data");
      }

      // Client's params (order/limit/select/own filters) ride along; the forced
      // ownership scope is ANDed on top so it can only narrow, never widen.
      let query = typeof body.params === "string" && body.params ? body.params : "?select=*";
      if (!query.startsWith("?")) query = "?" + query;
      // Defense-in-depth: this read runs with the SERVICE key (bypasses RLS), so block
      // PostgREST embeds (select=foo,bar(...)) — an embedded resource is fetched without
      // RLS and could surface related rows/columns the public key is denied. The app's
      // selects are always flat column lists; parentheses only ever mean an embed here.
      const rawSelect = (/[?&]select=([^&]*)/i.exec(query) || [])[1] || "";
      if (/[()]|%28|%29/i.test(rawSelect)) throw httpErr(400, "Embedded selects are not allowed");
      const json = await sbSelect(rtable, query + scope);
      return res.status(200).json(stripPins(json));
    }

    const table = String(body.table || "");
    if (!WRITABLE.has(table)) throw httpErr(400, `Table not writable: ${table}`);

    // ── Phase 1b: athlete ownership scoping ──────────────────────────────────
    // ownFilter is appended to update/delete queries (stays "" for coach callers,
    // which preserves their existing behavior exactly).
    let ownFilter = "";
    let coachIsMaster = false;
    if (caller.role === "athlete") {
      const col = ATHLETE_OWN_COL[table];
      if (!col) throw httpErr(403, "This account can't write that data");
      ownFilter = `&${col}=eq.${enc(caller.id)}`;
      // insert/upsert: every row must declare the caller as the owner.
      if (body.op === "insert" || body.op === "upsert") {
        const rows = Array.isArray(body.data) ? body.data : [body.data];
        for (const r of rows) {
          if (!r || typeof r !== "object") throw httpErr(400, `${body.op} requires data`);
          if (String(r[col]) !== String(caller.id)) {
            throw httpErr(403, "Cannot write another account's data");
          }
        }
      }
      // Per-column allowlist on sensitive tables (e.g. athletes): reject any field
      // the athlete isn't permitted to self-set, and enforce per-column value guards.
      const colRule = ATHLETE_COL_ALLOW[table];
      if (colRule && body.op !== "delete") {
        const rows = Array.isArray(body.data) ? body.data : [body.data];
        for (const r of rows) {
          if (!r || typeof r !== "object") throw httpErr(400, `${body.op} requires data`);
          for (const k of Object.keys(r)) {
            if (k === col) continue; // ownership column — already validated above
            if (!colRule.cols.has(k)) throw httpErr(403, `Field not editable: ${k}`);
            if (colRule.values && colRule.values[k] && !colRule.values[k](r[k])) {
              throw httpErr(403, `Value not allowed for ${k}`);
            }
          }
        }
      }
    }

    // ── Coach write scoping ───────────────────────────────────────────────────
    // Mirrors the READ scoping above: a coach may only WRITE within their remit.
    //   master → everything (no scope)
    //   admin  → their school (coaches + athletes + those athletes' data)
    //   coach  → their own roster only (athletes where coach_id == them, + that data)
    // Without this, ANY coach could write ANY row — another coach's athletes, other
    // schools, even create/delete coaches. ownFilter is ANDed onto update/delete so a
    // forged client filter can only narrow; insert/upsert payloads are checked row-by-row.
    if (caller.role === "coach") {
      const me = (await sbSelect("coaches", `?id=eq.${enc(caller.id)}&select=id,role,school_id`))[0];
      if (!me) throw httpErr(401, "Not authorized");
      coachIsMaster = me.role === "master";
      const isAdmin = me.role === "admin";

      if (!coachIsMaster) {
        const sid = me.school_id;
        const writeRows = () => (Array.isArray(body.data) ? body.data : [body.data]);
        // For insert/upsert, assert every row satisfies the ownership predicate.
        const assertRows = (ok) => {
          if (body.op !== "insert" && body.op !== "upsert") return;
          for (const r of writeRows()) {
            if (!r || typeof r !== "object") throw httpErr(400, `${body.op} requires data`);
            if (!ok(r)) throw httpErr(403, "Cannot write another account's data");
          }
        };

        if (table === "schools") {
          // School records (tier, limits, codes) are master-only.
          throw httpErr(403, "This account can't write that data");
        } else if (table === "coaches") {
          if (!isAdmin) {
            // Managing coaches is admin-only — EXCEPT a coach may update their OWN
            // self-service columns (notification_prefs, tour_done_at, crew_allowed).
            // Only those, only their row. crew_allowed is the coach's Crew
            // kill-switch for their whole roster (Will, 07-30) — it belongs here
            // rather than under admin because every coach owns the call for their
            // own athletes, not just a school admin.
            const keys = Object.keys(body.data || {});
            if (body.op === "update" && keys.length && keys.every((k) => k === "notification_prefs" || k === "tour_done_at" || k === "crew_allowed")) {
              ownFilter = `&id=eq.${enc(caller.id)}`;
            } else {
              throw httpErr(403, "This account can't write that data");
            }
          } else {
            // admin → coaches within their own school.
            ownFilter = `&school_id=eq.${enc(sid)}`;
            assertRows((r) => String(r.school_id) === String(sid));
            // Seat limit (schools.max_coaches) is what the school tier bills for —
            // enforce it server-side, not just in the Account tab UI. Count matches
            // the client's atLimit gate (non-admin rows), minus soft-removed seats
            // (access_code REMOVED_*) so the server is never STRICTER than the UI —
            // the happy path can't hit this, keeping the change invisible.
            if (body.op === "insert" || body.op === "upsert") {
              const school = (await sbSelect("schools", `?id=eq.${enc(sid)}&select=max_coaches`))[0];
              const maxCoaches = school?.max_coaches || 3;
              const seated = (await sbSelect("coaches", `?school_id=eq.${enc(sid)}&select=id,role,access_code`))
                .filter((c) => c.role !== "admin" && !String(c.access_code || "").startsWith("REMOVED_"))
                .length;
              const adding = writeRows().filter((r) => r && r.role !== "admin").length;
              if (seated + adding > maxCoaches) {
                throw httpErr(403, `Coach limit reached for your plan (${maxCoaches} max).`);
              }
            }
          }
        } else if (table === "athletes") {
          // admin → any athlete in their school; coach → only their own roster.
          ownFilter = isAdmin ? `&school_id=eq.${enc(sid)}` : `&coach_id=eq.${enc(caller.id)}`;
          assertRows((r) => (isAdmin ? String(r.school_id) === String(sid) : String(r.coach_id) === String(caller.id)));
        } else if (table === "coach_context" || table === "coach_push_subscriptions" || table === "program_change_requests" || table === "proof_digests" || table === "program_drafts" || table === "coach_programs") {
          // program_drafts: the coach writes their OWN drafts (coach_id = them).
          // The athlete_id a draft targets isn't roster-asserted here — a draft is
          // the coach's private workspace; APPLYING it goes through the athletes-
          // table write above, which IS roster-scoped.
          // The coach's OWN data (context notes, push subs), their request inbox, and
          // their reports — all carry coach_id (per-athlete digests carry the owning
          // coach_id too, so this also lets a coach mark those read without widening).
          // A regular coach may write these for themselves — the self-service carve-out
          // around the coaches-table admin-only rule. Scope + assert on coach_id.
          ownFilter = `&coach_id=eq.${enc(caller.id)}`;
          assertRows((r) => String(r.coach_id) === String(caller.id));
        } else {
          // Athlete-owned data tables: scope to the coach's athlete set (the same set
          // the read path returns), keyed by athlete_id.
          const col = ATHLETE_OWN_COL[table];
          if (!col) throw httpErr(403, "This account can't write that data");
          const roster = isAdmin
            ? await sbSelect("athletes", `?school_id=eq.${enc(sid)}&select=id`)
            : await sbSelect("athletes", `?coach_id=eq.${enc(caller.id)}&select=id`);
          const ids = roster.map((a) => String(a.id));
          // Empty roster → a sentinel uuid that never matches a real row, so update/
          // delete become safe no-ops and insert/upsert payloads are rejected below.
          const inList = ids.length ? ids.map((id) => `"${id}"`).join(",") : `"00000000-0000-0000-0000-000000000000"`;
          ownFilter = `&${col}=in.(${inList})`;
          assertRows((r) => ids.includes(String(r[col])));
        }
      }
    }

    if (body.op === "insert") {
      if (body.data == null || typeof body.data !== "object") throw httpErr(400, "insert requires data");
      // Coach alert context must be computed BEFORE the rows land (the pain-dedupe
      // and PR-improvement checks compare against pre-insert state). Best-effort:
      // a failure here can never block or fail the athlete's write.
      let coachAlert = null;
      try { coachAlert = await prepCoachAlert(caller, table, body.data); }
      catch (e) { console.error("[data] coach alert prep failed:", e.message); }
      const json = await sbWrite({ method: "POST", table, body: body.data });
      if (coachAlert) {
        try { await notifyCoachLazy(coachAlert.coachId, coachAlert.prefKey, coachAlert.msg); }
        catch (e) { console.error("[data] coach alert send failed:", e.message); }
      }
      return res.status(200).json(stripPins(json));
    }

    if (body.op === "update") {
      if (body.data == null || typeof body.data !== "object") throw httpErr(400, "update requires data");
      // Update by an explicit PostgREST filter (e.g. "?coach_id=eq.<uuid>") or by id.
      const base = typeof body.params === "string" && body.params
        ? body.params
        : `?id=eq.${enc(str(body.id, { max: 64, name: "id" }))}`;
      const json = await sbWrite({ method: "PATCH", table, query: base + ownFilter, body: body.data });

      // ── Coach programming-update notification hook (notification policy v2) ──
      // ONLY a COACH-authored write to an athlete's program_text/temp_program_text
      // enqueues a debounced push (api/notify-program-changes.js, 15-min batching).
      // Deliberately narrow: `program_locked` (a lock TOGGLE, not programming
      // content) does not qualify on its own, and athlete/Joe self-edits to the
      // same columns never reach this branch (caller.role is "athlete" there).
      // The client always updates ONE athlete per call here (coach.jsx's bulk
      // assign loops one sbUpdate per athlete_id) — body.id is the athlete_id.
      if (caller.role === "coach" && table === "athletes" && body.id &&
          ("program_text" in body.data || "temp_program_text" in body.data)) {
        try {
          await sbWrite({
            method: "POST", table: "program_change_events", prefer: "return=minimal",
            body: { athlete_id: body.id },
          });
        } catch (e) { console.error("[data] program_change_events enqueue failed:", e.message); } // best-effort, never blocks the save
      }

      return res.status(200).json(stripPins(json));
    }

    if (body.op === "upsert") {
      if (body.data == null || typeof body.data !== "object") throw httpErr(400, "upsert requires data");
      const conflict = str(body.conflict, { max: 120, name: "conflict" });
      // Athlete upserts may ONLY conflict on their ownership column. The per-row check
      // above forces the payload's ownership column to equal the caller, but on_conflict
      // chooses WHICH existing row gets merged — so a conflict on a different unique key
      // (e.g. "id") could overwrite ANOTHER athlete's row while the payload still claims
      // the caller as owner. Pinning conflict to the ownership column means a merge can
      // only ever land on the caller's own row. The app only upserts on athlete_id.
      if (caller.role === "athlete" && conflict !== ATHLETE_OWN_COL[table]) {
        throw httpErr(403, "Upsert not allowed on that key");
      }
      // Non-master coaches had NO upsert path at all, on the reasoning that the app
      // never coach-upserts and upsert applies no ownFilter. That stopped being true
      // when the dashboard started parsing programs on demand: parseAndCacheProgram
      // spends a Haiku call and then upserts program_prescriptions — which 403'd for
      // every coach who isn't master. The cache row was therefore never written, so
      // the SAME programs were re-parsed on every single dashboard load, burning a
      // Haiku call per athlete per load, forever. (Audit's coach-admin invisible list.)
      //
      // Narrow carve-out rather than lifting the block: the parsed-program cache only,
      // conflicting only on athlete_id. Safety comes from two independent facts —
      // assertRows above already proved every row's athlete_id is on THIS coach's
      // roster, and pinning the conflict key to the ownership column means the merge
      // can only ever land on that same row. Anything else still 403s.
      if (caller.role === "coach" && !coachIsMaster && !(table === "program_prescriptions" && conflict === ATHLETE_OWN_COL[table])) {
        throw httpErr(403, "Upsert not allowed for this account");
      }
      const json = await sbWrite({
        method: "POST",
        table,
        query: `?on_conflict=${enc(conflict)}`,
        body: body.data,
        prefer: "resolution=merge-duplicates,return=representation",
      });
      return res.status(200).json(stripPins(json));
    }

    if (body.op === "delete") {
      // The app passes a PostgREST filter string (e.g. "?athlete_id=eq.<uuid>").
      const base = typeof body.params === "string" && body.params
        ? body.params
        : (body.id ? `?id=eq.${enc(str(body.id, { max: 64, name: "id" }))}` : "");
      if (!base) throw httpErr(400, "delete requires params or id");
      await sbWrite({ method: "DELETE", table, query: base + ownFilter, prefer: "return=minimal" });
      return res.status(200).json({ ok: true });
    }

    throw httpErr(400, "Unknown op");
  } catch (e) {
    return handleErr(e, res, caller, body);
  }
}

// ── Coach alert fanouts (notification policy v2.1, Will-approved 2026-07-22) ──
// The Settings toggles "Athlete injury" and "Big PR" previously controlled pushes
// that were never sent. Two of the three new coach alert types hook the athlete
// write path here (the third — "athlete goes quiet" — rides the inactivity cron
// in api/push.js). notifyCoach gates on the coach's own notification_prefs.
const getPD = (r) => {
  const pd = r?.parsed_data;
  if (typeof pd === "string") { try { return JSON.parse(pd); } catch { return {}; } }
  return pd || {};
};
// Lift grouping goes through the SAME canonical funnel as every other surface
// (resolveLift, see the taxonomy header in src/grit.js). Keying by raw lowercased
// name here would repeat the exact defect this release fixes on the client: a PR
// on "Squats"/"RDL"/"DB Bench" would compare against an empty bucket and the
// coach's big-PR alert would silently never fire for those lifts. Imported
// lazily alongside the sender so the hot path doesn't pay for it.
const epley = (w, r) => (!w || w <= 0) ? 0 : Math.round(w * (1 + (r || 1) / 30));
// T55: conversion from the single-source units module (no rounding at conversion).
const toLbsSrv = (w, unit) => toLbsShared(Number(w || 0), unit);

// Which of `rows` beat the athlete's existing best for the SAME canonical lift?
// Pure (resolveLift injected) so scripts/test-coach-alerts.mjs can exercise it
// without a DB or the web-push import. A lift with no prior row returns nothing:
// a first-ever PR is a baseline, not news worth pushing to a coach.
export function pickImprovedPRs(existing, rows, resolveLift) {
  const e1Of = (p) => p.estimated_1rm || epley(toLbsSrv(p.weight, p.unit), p.reps);
  const bestByEx = {};
  for (const p of existing || []) {
    const k = resolveLift(p.exercise || "").id;
    const e1 = e1Of(p);
    if (e1 > (bestByEx[k] || 0)) bestByEx[k] = e1;
  }
  return (rows || []).filter((r) => {
    const k = resolveLift(r.exercise || "").id;
    return bestByEx[k] && e1Of(r) > bestByEx[k];
  });
}

async function prepCoachAlert(caller, table, data) {
  if (caller.role !== "athlete") return null;
  const rows = Array.isArray(data) ? data : [data];

  if (table === "workouts") {
    const areas = [...new Set(rows.flatMap((r) => (getPD(r).pain_flags || []).map((p) => p && p.area).filter(Boolean)))];
    if (!areas.length) return null;
    const athlete = (await sbSelect("athletes", `?id=eq.${enc(caller.id)}&select=id,name,coach_id`))[0];
    if (!athlete?.coach_id) return null;
    // One injury alert per athlete per day: skip if an earlier row today already
    // flagged pain (multi-message sessions would otherwise ping the coach per message).
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const today = await sbSelect("workouts", `?athlete_id=eq.${enc(caller.id)}&created_at=gte.${dayStart.toISOString()}&select=parsed_data&limit=50`);
    if (today.some((w) => (getPD(w).pain_flags || []).length)) return null;
    return {
      coachId: athlete.coach_id, prefKey: "injury",
      msg: { title: "WILCO", body: `${athlete.name} flagged ${areas.join(", ")} pain in today's log.`, url: "/", type: "coach_injury" },
    };
  }

  if (table === "prs") {
    // "Big PR" = a true improvement over an existing best (first-ever PR rows are
    // baselines, not news). Compare against pre-insert state, grouped by canonical
    // lift id, with both sides converted to lbs so a kg-logged row ranks correctly.
    const existing = await sbSelect("prs", `?athlete_id=eq.${enc(caller.id)}&select=exercise,weight,reps,unit,estimated_1rm`);
    if (!existing.length) return null;
    const { resolveLift } = await import("./_grit.js");
    const improved = pickImprovedPRs(existing, rows, resolveLift);
    if (!improved.length) return null;
    const athlete = (await sbSelect("athletes", `?id=eq.${enc(caller.id)}&select=id,name,coach_id`))[0];
    if (!athlete?.coach_id) return null;
    const top = improved[0];
    const extra = improved.length > 1 ? ` (+${improved.length - 1} more)` : "";
    return {
      coachId: athlete.coach_id, prefKey: "big_pr",
      msg: { title: "WILCO", body: `${athlete.name} just hit a new ${top.exercise} PR: ${top.weight}${top.unit === "kg" ? "kg" : " lbs"} × ${top.reps || 1}.${extra}`, url: "/", type: "coach_pr" },
    };
  }

  return null;
}

// ─── WILCO Crew V1 — the `crew` op's action dispatch ─────────────────────────
// Every action resolves the peer set from the CALLER's OWN id, never from a
// client-supplied athlete id — a client must never be able to ask for an
// arbitrary athlete's moments, roster row, or peer set (build spec §6).
// Crew is athlete-only (no coach-facing surface in this build — spec §9).
const CREW_CODE_LEN = 4;

async function loadCallerAthlete(caller) {
  if (caller.role !== "athlete") throw httpErr(403, "This account can't use Crew");
  // sport + crew_team come along because they resolve the caller's TEAM, which
  // is what an org crew is scoped to since the 2026-07-30 review pass (#3).
  const rows = await sbSelect("athletes", `?id=eq.${enc(caller.id)}&select=id,name,crew_org_key,crew_code,school_id,coach_id,sport,crew_team,crew_goal_text,crew_goal_targets,crew_goal_label`);
  const me = rows[0];
  if (!me) throw httpErr(401, "Not authorized");
  return me;
}

function genCrewCode(name) {
  const base = String(name || "ATH").trim().split(/\s+/)[0].toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6) || "ATH";
  let suffix = "";
  for (let i = 0; i < CREW_CODE_LEN; i++) suffix += CREW_CODE_ALPHABET[Math.floor(Math.random() * CREW_CODE_ALPHABET.length)];
  return `${base}-${suffix}`;
}

// Server-side port of src/App.jsx's `trainedThisWeek` memo (Mon-Sun, real
// sessions only) — used for peers' roster rows, where the client can't read
// their raw workouts. Returns {athleteId -> Set<dow>}.
function trainedDaysThisWeekByAthlete(workoutRows) {
  const out = {};
  for (const w of workoutRows) {
    const pd = typeof w.parsed_data === "string" ? (JSON.parse(w.parsed_data || "{}")) : (w.parsed_data || {});
    const hasWork = (Array.isArray(pd.exercises) && pd.exercises.length > 0) || !!pd.run_data;
    if (!hasWork) continue;
    const d = new Date(w.created_at);
    const set = (out[w.athlete_id] = out[w.athlete_id] || new Set());
    set.add((d.getDay() + 6) % 7);
  }
  return out;
}

async function handleCrew(body, caller, res) {
  const action = String(body.action || "");
  const me = await loadCallerAthlete(caller);
  // Resolved ONCE per request and threaded everywhere below, so no action can
  // disagree with another about whether this caller is an org member. Since the
  // 2026-07-30 review pass this is the ONLY org test in the gateway: a raw
  // crew_org_key check would auto-crew informal coach links and test accounts
  // again (finding #2), which is the bug that shipped the first time.
  const org = await resolveCrewOrg(me);
  // A coach can switch Crew off for their whole roster. Enforced HERE, on every
  // action, not just by hiding the tab: a hidden tab is a suggestion, this is the
  // control. Absence of a coach, or a coach row we can't read, both mean allowed
  // (Crew's default state) — only an explicit false turns it off.
  if (!(await crewAllowedFor(me))) throw httpErr(403, "Your coach has turned Crew off for this team");

  if (action === "crew-code-ensure") {
    if (org.isOrg) throw httpErr(403, "Org accounts don't need a crew code");
    if (me.crew_code) return res.status(200).json({ code: me.crew_code });
    let code = null;
    for (let tries = 0; tries < 8 && !code; tries++) {
      const candidate = genCrewCode(me.name);
      try {
        await sbWrite({ method: "PATCH", table: "athletes", query: `?id=eq.${enc(me.id)}`, body: { crew_code: candidate }, prefer: "return=minimal" });
        code = candidate;
      } catch (e) {
        if (tries === 7) throw httpErr(500, "Couldn't generate a crew code, try again");
        // Likely a unique-constraint collision on crew_code — retry with a fresh suffix.
      }
    }
    return res.status(200).json({ code });
  }

  if (action === "crew-request") {
    if (org.isOrg) throw httpErr(403, "Org accounts can't add a crew by code");
    const code = str(body.code, { max: 20, name: "code" }).toUpperCase();
    const targets = await sbSelect("athletes", `?crew_code=eq.${enc(code)}&select=id,school_id,sport,crew_team`);
    const target = targets[0];
    if (!target) throw httpErr(404, "No athlete found with that code");
    if (String(target.id) === String(me.id)) throw httpErr(400, "That's your own code");
    // Org athletes can't be added by code either — enforced on BOTH sides so an
    // org kid can never be pulled into someone's individual crew. Resolved the
    // same way as the caller's own membership, not off crew_org_key, so a
    // school-linked athlete whose school isn't org-enabled stays addable.
    const targetOrg = await resolveCrewOrg(target);
    if (targetOrg.isOrg) throw httpErr(403, "That athlete can't be added by code");
    const myAccepted = await sbSelect("crew_edges", `?status=eq.accepted&or=(athlete_a.eq.${enc(me.id)},athlete_b.eq.${enc(me.id)})&select=id`);
    if (myAccepted.length >= CREW_CAP) throw httpErr(403, `Crew is full (max ${CREW_CAP})`);
    const [a, b] = orderedPair(me.id, target.id); // canonical ordering computed server-side — never trust a client-supplied order
    const already = await sbSelect("crew_edges", `?athlete_a=eq.${enc(a)}&athlete_b=eq.${enc(b)}&select=id,status`);
    if (already[0]) {
      if (already[0].status === "accepted") throw httpErr(400, "Already in your crew");
      return res.status(200).json({ ok: true, pending: true, id: already[0].id });
    }
    const inserted = await sbWrite({ method: "POST", table: "crew_edges", body: { athlete_a: a, athlete_b: b, status: "pending", requested_by: me.id }, prefer: "return=representation" });
    return res.status(200).json(Array.isArray(inserted) ? inserted[0] : inserted);
  }

  if (action === "crew-accept" || action === "crew-decline") {
    const id = str(body.id, { max: 64, name: "id" });
    const rows = await sbSelect("crew_edges", `?id=eq.${enc(id)}&select=*`);
    const edge = rows[0];
    if (!edge) throw httpErr(404, "Request not found");
    if (String(edge.athlete_a) !== String(me.id) && String(edge.athlete_b) !== String(me.id)) throw httpErr(403, "Not your request");
    if (action === "crew-decline") {
      await sbWrite({ method: "DELETE", table: "crew_edges", query: `?id=eq.${enc(id)}`, prefer: "return=minimal" });
      return res.status(200).json({ ok: true });
    }
    // Re-check the cap on the ACCEPTING side too — pending edges can pile up
    // past the cap since only accept/request enforce it, not pending inserts.
    const myAccepted = await sbSelect("crew_edges", `?status=eq.accepted&or=(athlete_a.eq.${enc(me.id)},athlete_b.eq.${enc(me.id)})&select=id`);
    if (myAccepted.length >= CREW_CAP) throw httpErr(403, `Crew is full (max ${CREW_CAP})`);
    const updated = await sbWrite({ method: "PATCH", table: "crew_edges", query: `?id=eq.${enc(id)}`, body: { status: "accepted", accepted_at: new Date().toISOString() }, prefer: "return=representation" });
    return res.status(200).json(Array.isArray(updated) ? updated[0] : updated);
  }

  if (action === "crew-remove") {
    // One-sided, silent — delete the row, no notification to the other side.
    // Not available on org membership — there is no edge to remove there.
    if (org.isOrg) throw httpErr(403, "Org membership can't be removed from here");
    const id = str(body.id, { max: 64, name: "id" });
    const rows = await sbSelect("crew_edges", `?id=eq.${enc(id)}&status=eq.accepted&select=id,athlete_a,athlete_b`);
    const edge = rows[0];
    if (!edge || (String(edge.athlete_a) !== String(me.id) && String(edge.athlete_b) !== String(me.id))) throw httpErr(404, "Not found");
    await sbWrite({ method: "DELETE", table: "crew_edges", query: `?id=eq.${enc(id)}`, prefer: "return=minimal" });
    return res.status(200).json({ ok: true });
  }

  if (action === "crew-list") {
    const peers = await crewPeerIds(me, undefined, org);
    // Pending requests (individual flow only — org membership has no request state).
    let pending = [];
    if (!org.isOrg) {
      pending = await sbSelect("crew_edges", `?status=eq.pending&or=(athlete_a.eq.${enc(me.id)},athlete_b.eq.${enc(me.id)})&select=*`);
      // Say WHO wants to join. "Someone wants to join your crew" is useless when
      // the whole decision is whether you know that person. They already have
      // your code, which is the only way to reach you, so their name is not a
      // disclosure: it is the one fact the accept/decline call needs.
      if (pending.length) {
        const otherIds = [...new Set(pending.map((e) => (String(e.athlete_a) === String(me.id) ? e.athlete_b : e.athlete_a)))];
        try {
          const names = await sbSelect("athletes", `?id=in.(${otherIds.map((id) => `"${id}"`).join(",")})&select=id,name`);
          const nameById = Object.fromEntries(names.map((a) => [String(a.id), a.name]));
          pending = pending.map((e) => ({
            ...e,
            otherName: nameById[String(String(e.athlete_a) === String(me.id) ? e.athlete_b : e.athlete_a)] || null,
          }));
        } catch { /* names are cosmetic — the request still renders and can still be accepted */ }
      }
    }
    // The caller's OWN goal, so the tab can show it back to them with the
    // share toggle (finding #4: share_with_crew had no write path anywhere, so
    // it was false for everyone and no goal ever reached a crew row). Returned
    // whether or not they have peers — an athlete with an empty crew should
    // still be able to see and set this.
    const myGoals = await loadOwnGoals(me.id);
    const crewGoal = await loadCrewGoal(me.id);
    if (!peers.length) {
      return res.status(200).json({ isOrg: org.isOrg, team: org.teamName, code: me.crew_code || null, pending, roster: [], myGoals, crewGoal });
    }
    const idList = peers.map((id) => `"${id}"`).join(",");
    // The caller's OWN week rides along in the same this-week query, because the
    // crew reads as one object in the UI (the spine) and leaving yourself out of
    // your own crew's total makes that number quietly wrong.
    const weekIdList = [...peers, me.id].map((id) => `"${id}"`).join(",");
    const [athletesRows, goalsRows, workoutRows, recentWorkoutRows] = await Promise.all([
      sbSelect("athletes", `?id=in.(${idList})&select=id,name,training_days_per_week,crew_goal_targets,crew_goal_label`),
      // Goal-at-a-glance ONLY for peers who opted in (share_with_crew=true) — default
      // off. ALL of their shared goals, not just the latest: an athlete can be
      // chasing three lifts across three separate goals and the row shows them all.
      sbSelect("athlete_goals", `?athlete_id=in.(${idList})&share_with_crew=eq.true&order=created_at.desc&select=*`),
      sbSelect("workouts", `?athlete_id=in.(${weekIdList})&created_at=gte.${enc(mondayIso())}&select=athlete_id,parsed_data,created_at`),
      // Quiet-crewmate nudge (8-day rule): bounded to a generous window so "quiet"
      // still distinguishes from "never logged" without an unbounded per-peer scan.
      sbSelect("workouts", `?athlete_id=in.(${idList})&created_at=gte.${enc(new Date(Date.now() - 400 * 864e5).toISOString())}&select=athlete_id,created_at&order=created_at.desc`),
    ]);
    // Accepted edges, keyed by the OTHER side, so each roster row knows its own
    // comparison state without a query per row.
    const acceptedEdgeByPeer = {};
    if (!org.isOrg) {
      const accepted = await sbSelect("crew_edges", `?status=eq.accepted&or=(athlete_a.eq.${enc(me.id)},athlete_b.eq.${enc(me.id)})&select=*`);
      for (const e of accepted) acceptedEdgeByPeer[String(e.athlete_a) === String(me.id) ? e.athlete_b : e.athlete_a] = e;
    }
    const trainedByAthlete = trainedDaysThisWeekByAthlete(workoutRows);
    // Current block's goal only, same rule as loadOwnGoals - a revised goal writes a
    // new row, so keeping every row made one lift show up once per revision. goalsRows
    // is ordered created_at.desc, so the first hit per athlete is their current one.
    const goalsByAthlete = {};
    for (const g of goalsRows) if (!goalsByAthlete[g.athlete_id]) goalsByAthlete[g.athlete_id] = [g];
    const lastWorkoutAt = {};
    for (const w of recentWorkoutRows) if (!lastWorkoutAt[w.athlete_id]) lastWorkoutAt[w.athlete_id] = w.created_at; // query is DESC — first hit per id is the latest

    // A peer's goal progress needs their current e1RM for the parsed lift — the
    // ONLY numbers server-computed this way are ones the roster already needs to
    // show; a peer's raw workouts are never returned to the caller, only this
    // one derived number (never included in the response for org callers'
    // comparison fields — there ARE no comparison fields here; see below).
    const { resolveLift, bestE1RMForExercise, toLbs, epley1RM } = await import("./_grit.js");
    const roster = [];
    for (const a of athletesRows) {
      // One current-e1RM lookup per DISTINCT lift this athlete is chasing, shared
      // across however many goals name it, rather than one per goal.
      const myGoals = goalsByAthlete[a.id] || [];
      const currentByLift = {};
      for (const t of myGoals.flatMap(goalTargets)) {
        const key = t.lift.toLowerCase();
        if (key in currentByLift) continue;
        currentByLift[key] = await bestE1rmLbsForLift(a.id, t.lift, { resolveLift, bestE1RMForExercise, toLbs, epley1RM });
      }
      // Display decided server-side, per target (chasing / hit / quiet), plus the
      // short labels for goals with nothing measurable in them. `quiet` is the
      // missed-dated-goal case and is deliberately NOT a miss — see
      // goalTargetState in api/_crew.js.
      // A crew-goal override REPLACES what this athlete's row shows. They wrote it
      // FOR their crew, so it is implicitly shared and their per-goal share flags
      // stop applying. Their real goals are untouched: nothing outside this
      // surface reads these columns, so the AI still programs off the real thing.
      const override = (Array.isArray(a.crew_goal_targets) && a.crew_goal_targets.length) || a.crew_goal_label
        ? [{ parsed_targets: a.crew_goal_targets, short_label: a.crew_goal_label }]
        : null;
      if (override) {
        for (const t of goalTargets(override[0])) {
          const key = t.lift.toLowerCase();
          if (key in currentByLift) continue;
          currentByLift[key] = await bestE1rmLbsForLift(a.id, t.lift, { resolveLift, bestE1RMForExercise, toLbs, epley1RM });
        }
      }
      const goal = composeGoalGlance(override || myGoals, currentByLift);
      // NOTE: compare_a/compare_b (V2 opt-in) are never selected/returned here at
      // all — there is no comparison surface in V1, org or individual. When V2
      // lands, this is the spot that must keep stripping those fields for org
      // callers (see api/_crew.js's org-comparison ban + the DB trigger).
      const lastAt = lastWorkoutAt[a.id] || null;
      const quietDays = lastAt ? Math.floor((Date.now() - new Date(lastAt).getTime()) / 864e5) : null;
      const cmp = compareStateFor(acceptedEdgeByPeer[a.id], me.id);
      roster.push({
        id: a.id, name: a.name,
        // V2 comparison opt-in, my side and whether it's mutual. Org rosters have
        // no edges, so this is always off for them, which is the permanent ban.
        compareMine: cmp.mine, compareMutual: cmp.mutual,
        trainedThisWeek: (trainedByAthlete[a.id] || new Set()).size,
        trainingDaysPerWeek: a.training_days_per_week || null,
        goal,
        // Quiet-crewmate nudge (spec: 8-day rule, private, sender-only — the CLIENT
        // decides whether to show "send a 💪", this is just the raw day count).
        // null = no session in the 400-day window (treat as quiet, day count unknown).
        quietDays,
      });
    }
    const meRows = await sbSelect("athletes", `?id=eq.${enc(me.id)}&select=training_days_per_week`);
    const myWeek = {
      trainedThisWeek: (trainedByAthlete[me.id] || new Set()).size,
      trainingDaysPerWeek: (meRows[0] && meRows[0].training_days_per_week) || null,
    };
    return res.status(200).json({ isOrg: org.isOrg, team: org.teamName, code: me.crew_code || null, pending, roster, myGoals, crewGoal, myWeek });
  }

  if (action === "crew-feed") {
    const peers = await crewPeerIds(me, undefined, org);
    const ids = [...new Set([...peers, me.id])]; // peer set ∪ caller's own id
    if (!ids.length) return res.status(200).json([]);
    const idList = ids.map((id) => `"${id}"`).join(",");
    // The rolling window stays (pr/week 7 days, goal/milestone 14) so an active crew
    // reads fresh. But it used to empty the tab completely once everything aged out,
    // which is what Will hit: three moments existed and the newest had expired the day
    // before, so Moments looked broken rather than quiet. So reach back far enough to
    // have a fallback, and if nothing is in-window show the LAST 3 regardless of age
    // (Will, 08-12) — a quiet crew shows its most recent history instead of nothing.
    // Bounded by an explicit limit: an unbounded select truncates silently at 1,000.
    const since = new Date(Date.now() - 400 * 864e5).toISOString();
    const rows = await sbSelect("crew_moments", `?athlete_id=in.(${idList})&created_at=gte.${enc(since)}&select=*&order=created_at.desc&limit=200`);
    const inWindow = rows.filter((m) => withinWindow(m));
    const visible = inWindow.length ? inWindow : rows.slice(0, 3);
    if (!visible.length) return res.status(200).json([]);
    const nameIds = [...new Set(visible.map((m) => m.athlete_id))];
    const nameRows = await sbSelect("athletes", `?id=in.(${nameIds.map((id) => `"${id}"`).join(",")})&select=id,name`);
    const nameById = Object.fromEntries(nameRows.map((a) => [a.id, a.name]));
    const momentIds = visible.map((m) => `"${m.id}"`).join(",");
    const reactions = await sbSelect("crew_reactions", `?moment_id=in.(${momentIds})&select=*`);
    const reactionsByMoment = {};
    for (const r of reactions) (reactionsByMoment[r.moment_id] = reactionsByMoment[r.moment_id] || []).push(r);
    // stale=true lets the UI say these are older, rather than implying they just landed.
    const stale = !inWindow.length;
    return res.status(200).json(visible.map((m) => ({ ...m, stale, athleteName: nameById[m.athlete_id] || null, reactions: reactionsByMoment[m.id] || [] })));
  }

  // Goal sharing opt-in (finding #4). Default is OFF and stays OFF until the
  // athlete flips it here — this is the only write path to share_with_crew, and
  // it can only ever touch the CALLER's own most recent goal.
  // What your CREW sees of your goals, which is not the same question as what
  // you are training for. Writes only to the athletes.crew_goal_* columns, which
  // nothing outside this surface reads, so it can never change what the AI
  // programs against. Sending empty text clears the override and your real
  // shared goals come back.
  if (action === "crew-goal-display") {
    const text = String(body.text ?? "").trim().slice(0, 600);
    const patch = text
      ? {
          crew_goal_text: text,
          crew_goal_targets: Array.isArray(body.targets) ? body.targets.slice(0, 8) : [],
          crew_goal_label: body.label ? String(body.label).slice(0, 60) : null,
          crew_goal_at: new Date().toISOString(),
        }
      : { crew_goal_text: null, crew_goal_targets: null, crew_goal_label: null, crew_goal_at: null };
    await sbWrite({ method: "PATCH", table: "athletes", query: `?id=eq.${enc(me.id)}`, body: patch, prefer: "return=minimal" });
    return res.status(200).json({ ok: true, crewGoal: await loadCrewGoal(me.id) });
  }

  if (action === "crew-goal-share") {
    const share = body.share === true;
    // Per GOAL now, not per athlete: someone can share the bench number and keep
    // the rest to themselves. The athlete_id filter is what stops a client
    // flipping sharing on somebody else's goal.
    let goalId = body.goalId ? str(body.goalId, { max: 64, name: "goalId" }) : null;
    if (!goalId) {
      const rows = await sbSelect("athlete_goals", `?athlete_id=eq.${enc(me.id)}&order=created_at.desc&limit=1&select=id`);
      if (!rows[0]) throw httpErr(404, "No goal to share yet");
      goalId = rows[0].id;
    }
    await sbWrite({ method: "PATCH", table: "athlete_goals", query: `?id=eq.${enc(goalId)}&athlete_id=eq.${enc(me.id)}`, body: { share_with_crew: share }, prefer: "return=minimal" });
    return res.status(200).json({ ok: true, share, myGoals: await loadOwnGoals(me.id) });
  }

  // ── V2 comparison ────────────────────────────────────────────────────────
  // Mutual opt-in, individual crews only. An org athlete has no crew_edges row
  // at all, so both actions below simply have nothing to act on for them; the
  // explicit reject is the belt to the DB trigger's braces.
  if (action === "crew-compare-set") {
    if (org.isOrg) throw httpErr(403, "Comparison isn't available on a team account");
    const on = body.on === true;
    const peerId = str(body.peerId, { max: 64, name: "peerId" });
    const [a, b] = orderedPair(me.id, peerId);
    const rows = await sbSelect("crew_edges", `?athlete_a=eq.${enc(a)}&athlete_b=eq.${enc(b)}&status=eq.accepted&select=*`);
    const edge = rows[0];
    if (!edge) throw httpErr(404, "Not in your crew");
    // Only ever flips the CALLER's own side. Turning it off is silent by design:
    // the other person is never told, so switching off costs nothing socially.
    const col = String(edge.athlete_a) === String(me.id) ? "compare_a" : "compare_b";
    const updated = await sbWrite({ method: "PATCH", table: "crew_edges", query: `?id=eq.${enc(edge.id)}`, body: { [col]: on }, prefer: "return=representation" });
    const fresh = Array.isArray(updated) ? updated[0] : updated;
    return res.status(200).json({ ok: true, ...compareStateFor(fresh, me.id) });
  }

  if (action === "crew-compare") {
    if (org.isOrg) return res.status(200).json({ me: null, peers: [] });
    const edges = await sbSelect("crew_edges", `?status=eq.accepted&or=(athlete_a.eq.${enc(me.id)},athlete_b.eq.${enc(me.id)})&select=*`);
    const mutual = edges.filter((e) => compareStateFor(e, me.id).mutual);
    if (!mutual.length) return res.status(200).json({ me: null, peers: [] });
    const peerIds = mutual.map((e) => (String(e.athlete_a) === String(me.id) ? e.athlete_b : e.athlete_a));
    // The CALLER's own snapshot comes from the same function as the peers', so a
    // head-to-head is one piece of math against itself. Computing your own score
    // client-side and theirs server-side would let the two drift and quietly put
    // a wrong number beside a right one.
    const [mine, peers] = await Promise.all([comparePeers([me.id]), comparePeers(peerIds)]);
    return res.status(200).json({ me: mine[0] || null, peers });
  }

  if (action === "crew-react") {
    const momentId = str(body.momentId, { max: 64, name: "momentId" });
    const emoji = String(body.emoji || "");
    if (!REACTION_EMOJI.has(emoji)) throw httpErr(400, "Invalid reaction");
    const moments = await sbSelect("crew_moments", `?id=eq.${enc(momentId)}&select=id,athlete_id`);
    const moment = moments[0];
    if (!moment) throw httpErr(404, "Moment not found");
    if (String(moment.athlete_id) !== String(me.id)) {
      const peers = await crewPeerIds(me, undefined, org);
      if (!peers.includes(String(moment.athlete_id))) throw httpErr(403, "Not in your crew");
    }
    const existing = await sbSelect("crew_reactions", `?moment_id=eq.${enc(momentId)}&athlete_id=eq.${enc(me.id)}&emoji=eq.${enc(emoji)}&select=id`);
    if (existing[0]) {
      // Toggle: react twice = off, not two rows (crew_reactions_once backs this).
      await sbWrite({ method: "DELETE", table: "crew_reactions", query: `?id=eq.${enc(existing[0].id)}`, prefer: "return=minimal" });
      return res.status(200).json({ ok: true, reacted: false });
    }
    await sbWrite({ method: "POST", table: "crew_reactions", body: { moment_id: momentId, athlete_id: me.id, emoji }, prefer: "return=minimal" });
    return res.status(200).json({ ok: true, reacted: true });
  }

  throw httpErr(400, "Unknown crew action");
}

// Build the comparison payload for a set of mutually-opted-in peers.
//
// What goes out is TIER and WITHIN-TIER POSITION only, plus a strength score.
// Never an e1RM, a bodyweight, an age or a gender. That is the design rule
// ("ranks and tiers, never raw weights") and enforcing it at the point the data
// is assembled means no client mistake can leak what was never sent.
//
// Each peer's numbers come from computeGritSnapshot, the SAME function that
// produces the athlete's own Benchmarks tab, so a strip and the tube it rides on
// are computed by one piece of math rather than two that can drift.
async function comparePeers(peerIds) {
  const { computeGritSnapshot, BENCH_THRESHOLDS, scaledThresholds, TIER_NAMES } = await import("./_grit.js");
  const idList = peerIds.map((id) => `"${id}"`).join(",");
  const athletes = await sbSelect("athletes", `?id=in.(${idList})&select=id,name,weight_lbs,gender,birthday`);
  const out = [];
  for (const a of athletes) {
    const bodyweight = a.weight_lbs || 0;
    if (!bodyweight) { out.push({ id: a.id, name: a.name, strengthScore: null, lifts: {} }); continue; }
    const genderKey = a.gender === "Female" ? "female" : "male";
    const age = a.birthday ? Math.floor((Date.now() - new Date(a.birthday).getTime()) / (365.25 * 864e5)) : null;
    let snap = null;
    try {
      const [workouts, prs, manual] = await Promise.all([
        sbSelect("workouts", `?athlete_id=eq.${enc(a.id)}&select=parsed_data,created_at&order=created_at.desc&limit=100`),
        sbSelect("prs", `?athlete_id=eq.${enc(a.id)}&select=exercise,weight,reps,unit,estimated_1rm`),
        sbSelect("manual_one_rms", `?athlete_id=eq.${enc(a.id)}&select=normalized_exercise,exercise,weight,unit`),
      ]);
      snap = computeGritSnapshot(workouts, manual, { bodyweightLbs: bodyweight, gender: a.gender, age, seedFromPRs: prs });
    } catch {
      // Best effort: a peer whose history fails to load simply shows no strips
      // rather than breaking everyone else's comparison.
      out.push({ id: a.id, name: a.name, strengthScore: null, lifts: {} });
      continue;
    }
    const lifts = {};
    for (const b of snap.rankedLifts || []) {
      const threshRaw = BENCH_THRESHOLDS[genderKey]?.[b.benchKey];
      if (!threshRaw || !b.benchKey) continue;
      const thresh = scaledThresholds(threshRaw, bodyweight, genderKey, age);
      const pct = withinTierPct(b.e1rm / bodyweight, thresh, b.tierIdx, TIER_NAMES.length);
      if (pct == null) continue;
      lifts[b.benchKey] = { tierIdx: b.tierIdx, pct };
    }
    out.push({ id: a.id, name: a.name, strengthScore: snap.strengthScore ?? null, topTierIdx: snap.topTierIdx ?? null, lifts });
  }
  return out;
}

// The caller's OWN goals. An athlete can have several, each holding several
// targets, and they control sharing per goal. Returns one entry per goal row so
// the tab can list them with their own toggles, plus a combined glance rendered
// with the exact same component a peer's row uses.
//
// `needsParse` is how a goal written before multi-target parsing existed gets
// picked up: the client re-parses ITS OWN goals once, on open, and persists the
// result. Never on render of anyone else's row, and never more than once per
// goal, so the AI cost stays bounded and nobody's goal is parsed by a stranger's
// device.
// The caller's own crew-goal override, rendered through the exact component a
// peer's row uses, so what they see in the editor is what their crew sees.
async function loadCrewGoal(athleteId) {
  const rows = await sbSelect("athletes", `?id=eq.${enc(athleteId)}&select=crew_goal_text,crew_goal_targets,crew_goal_label`);
  const a = rows[0];
  if (!a || !a.crew_goal_text) return null;
  const row = { parsed_targets: a.crew_goal_targets, short_label: a.crew_goal_label };
  const { resolveLift, bestE1RMForExercise, toLbs, epley1RM } = await import("./_grit.js");
  const currentByLift = {};
  for (const t of goalTargets(row)) {
    const key = t.lift.toLowerCase();
    if (key in currentByLift) continue;
    currentByLift[key] = await bestE1rmLbsForLift(athleteId, t.lift, { resolveLift, bestE1RMForExercise, toLbs, epley1RM });
  }
  return { text: a.crew_goal_text, glance: composeGoalGlance([row], currentByLift, Date.now(), 0) };
}

async function loadOwnGoals(athleteId) {
  const all = await sbSelect("athlete_goals", `?athlete_id=eq.${enc(athleteId)}&order=created_at.desc&limit=12&select=*`);
  // CURRENT block's goal only (Will, 08-12). Every row used to render its own card,
  // but a goal that gets REVISED writes a new row rather than editing the old one -
  // so "bench 315 by end of summer" and "bench 315 pushed back past mid-August" both
  // showed, and Bench Press appeared twice with two different targets. Newest row
  // wins; the history stays in the table for the coach brain.
  const rows = all.slice(0, 1);
  if (!rows.length) return [];
  const { resolveLift, bestE1RMForExercise, toLbs, epley1RM } = await import("./_grit.js");
  const currentByLift = {};
  for (const t of rows.flatMap(goalTargets)) {
    const key = t.lift.toLowerCase();
    if (key in currentByLift) continue;
    currentByLift[key] = await bestE1rmLbsForLift(athleteId, t.lift, { resolveLift, bestE1RMForExercise, toLbs, epley1RM });
  }
  return rows.map((g) => ({
    id: g.id,
    text: g.goal_text,
    shared: g.share_with_crew === true,
    // Uncapped for your own goals: the cap exists to keep a ROSTER scannable.
    glance: composeGoalGlance([g], currentByLift, Date.now(), 0),
    needsParse: !g.parsed_at,
  }));
}

function mondayIso() {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - dow);
  return monday.toISOString();
}

function handleErr(e, res, caller, body) {
    const status = e.status || 500;
    // Log only genuine reliability events (5xx — e.g. a Supabase write/read that
    // failed). Routine 4xx (auth/validation) are normal user flow, not failures, so
    // logging them would just create noise. We deliberately do NOT read the DB to
    // snapshot school/tier here — we may be in this catch *because* the DB failed —
    // so we attribute only with what authCaller already gave us (in memory).
    if (status >= 500) {
      logError({
        source: "server", severity: "error", area: "data", route: "api/data",
        error_type: `http_${status}`, message: e.message, status_code: status,
        role: caller?.role, actor_id: caller?.id,
        athlete_id: caller?.role === "athlete" ? caller.id : null,
        meta: { op: body.op, table: body.table },
      });
    }
    return res.status(status).json({ error: e.message || "Server error" });
}
