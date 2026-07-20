// ─── COACH TEAM ANALYTICS (C2 follow-up: server-side aggregation) ─────────────
// The Overview / Group-Progress team aggregations, computed HERE instead of in the
// coach's browser. The dashboard used to ship the whole roster's 90-day raw workout
// window to the phone (~58k rows at 500 athletes) and aggregate client-side; this
// endpoint runs the SAME math (api/_coachanalytics.js → src/coachAnalytics.js, which
// imports the exact grit/proofcore primitives) over a server-side read and returns
// compact JSON summaries — a few KB regardless of roster size.
//
// POST { coachId, pin, tzOffsetMinutes? }  — or session-token auth: { auth:{role:"coach",id,token}, tzOffsetMinutes? }
//   → { strength, running:{distSeries,paceSeries,hrSeries},
//       feel:{feelCounts,feelTotal}, weekPain, movers, mostImproved, computedAt }
//
// Auth + role scoping mirror api/identity.js coach-dashboard exactly:
//   master → all athletes; admin → their school; coach → their own roster.
// tzOffsetMinutes (the client's `new Date().getTimezoneOffset()`) pins the Mon–Sun
// week and date labels to the COACH'S wall clock — the server runs UTC.

import { applyCors, httpErr, str, pin4, verifyPin, tryTokenAuth, sbSelect, logError } from "./_supa.js";
import {
  weekBounds, teamStrengthWeekly, teamRunningWeekly,
  weekFeelDistribution, weekPainFlags, teamMovers, mostImproved60,
} from "./_coachanalytics.js";

const enc = encodeURIComponent;

// Same look-back the dashboard's raw-window load uses (COACH_WINDOW_DAYS in
// src/coach.jsx): every aggregation here reads ≤12 weeks; 90d covers all of them
// (12wk strength/running charts, 60d most-improved, 2wk movers, 1wk feel/pain).
const WINDOW_DAYS = 90;

// Paged read (PostgREST caps a request at 1000 rows). Bounded by the same 50k
// safety ceiling as the client pager; hitting it just truncates the OLDEST rows
// in the window (order is created_at.desc) and logs the signal to shrink WINDOW_DAYS
// or move this to a matview.
const PAGE = 1000, MAX_ROWS = 50000;
async function pagedSelect(table, baseQuery) {
  const rows = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const page = await sbSelect(table, `${baseQuery}&limit=${PAGE}&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE) break;
    if (offset + PAGE >= MAX_ROWS) console.warn(`[coach-analytics] ${table} hit the ${MAX_ROWS}-row ceiling`);
  }
  return rows;
}

export const maxDuration = 30;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  body = body || {};

  try {
    // ── auth ──────────────────────────────────────────────────────────────────
    // Fast path: a valid signed COACH session token authenticates with zero bcrypt
    // (same as api/data.js). Fallback: coachId + PIN, verbatim identity.js authCoach.
    // Either way the DB row is re-read — it's the source of truth for role/school.
    let me;
    const tok = tryTokenAuth(body.auth);
    if (tok && tok.role === "coach") {
      me = (await sbSelect("coaches", `?id=eq.${enc(tok.id)}&select=*`))[0];
      if (!me) throw httpErr(401, "Not authorized");
    } else {
      const id = str(body.coachId, { max: 64, name: "coachId" });
      const p = pin4(body.pin);
      me = (await sbSelect("coaches", `?id=eq.${enc(id)}&select=*`))[0];
      if (!me || !(await verifyPin(p, me.pin))) throw httpErr(401, "Not authorized");
    }
    const isMaster = me.role === "master";
    const isAdmin = me.role === "admin";

    // ── roster: same role scoping as coach-dashboard ──────────────────────────
    // Only the fields the aggregations read (bodyweight for e1RM, name for pain).
    // (`a.weight` in the client's `weight_lbs||weight` fallback isn't a real column —
    // it's always undefined there too, so it is not selected.)
    const ATH_COLS = "id,name,weight_lbs,gender,age,school_id,coach_id";
    const athletes = isMaster
      ? await pagedSelect("athletes", `?order=created_at.desc,id.desc&select=${ATH_COLS}`)
      : isAdmin && me.school_id
        ? await pagedSelect("athletes", `?school_id=eq.${enc(me.school_id)}&order=created_at.desc,id.desc&select=${ATH_COLS}`)
        : await pagedSelect("athletes", `?coach_id=eq.${enc(me.id)}&order=created_at.desc,id.desc&select=${ATH_COLS}`);

    // ── workouts: the roster's recent window, only the columns the math reads ─
    // Master reads the window unscoped (their roster IS everyone); scoped callers
    // chunk the id in-list so the URL stays bounded on big rosters.
    const since = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString();
    const WO_COLS = "id,athlete_id,created_at,parsed_data";
    let workouts = [];
    if (isMaster) {
      workouts = await pagedSelect("workouts", `?created_at=gte.${enc(since)}&order=created_at.desc,id.desc&select=${WO_COLS}`);
    } else {
      const ids = athletes.map((a) => a.id);
      for (let i = 0; i < ids.length; i += 100) {
        const inList = ids.slice(i, i + 100).map((x) => `"${x}"`).join(",");
        workouts.push(...await pagedSelect("workouts", `?athlete_id=in.(${inList})&created_at=gte.${enc(since)}&order=created_at.desc,id.desc&select=${WO_COLS}`));
      }
      // Re-establish the single global created_at.desc order the client's one-query
      // fetch had (weekPain preserves iteration order into its rendered list).
      workouts.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : (a.id < b.id ? 1 : -1)));
    }

    // ── compute (one pinned now; coach-local week + labels via tz offset) ─────
    const now = Date.now();
    const tz = Number.isFinite(+body.tzOffsetMinutes) ? +body.tzOffsetMinutes : 0;
    const wk = weekBounds(now, tz);

    // "Most Improved" is the SCHOOL leaderboard — same athlete set the client used
    // (roster rows with this school_id; master has no school → empty, matching the
    // client's school-gated render).
    const schoolAthletes = me.school_id ? athletes.filter((a) => a.school_id === me.school_id) : [];

    return res.status(200).json({
      strength: teamStrengthWeekly(athletes, workouts, now, tz),
      running: teamRunningWeekly(athletes, workouts, now, tz),
      feel: weekFeelDistribution(workouts, wk, now),
      weekPain: weekPainFlags(workouts, athletes, wk, now),
      movers: teamMovers(athletes, workouts, wk, now),
      mostImproved: schoolAthletes.length >= 2 ? mostImproved60(schoolAthletes, workouts, now) : [],
      computedAt: new Date(now).toISOString(),
    });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) {
      logError({
        source: "server", severity: "error", area: "coach", route: "api/coach-analytics",
        error_type: `http_${status}`, message: e.message, status_code: status,
      });
    }
    return res.status(status).json({ error: e.message || "Server error" });
  }
}
