// ─── T70 STATS — the Stats tab and the Proof feed's BY THE NUMBERS block ─────
// Every number here comes from the athlete_stats row the server keeps
// (src/stats.js computeAthleteStats, refreshed after every workouts write), read
// through the gateway like any other athlete table. Nothing is summed from raw
// workout rows on the phone, so a 500-log history costs one small read.
//
// Will's rulings (10-02, round 2): Stats lives in My Log between Workouts and
// Proof · ranges are 1W · 1M · 3M · 1Y (Stats opens on 1Y, graphs on 3M) ·
// lifetime facts sit in their own Career card · NO Grit rank here (Benchmarks
// owns ranks) · NO share cards · favorite exercise by sets · signup baselines
// never count as PRs · one object comparison per total · the Proof block is a
// SECTION of every edition, drawn as a grid in the opened letter.
//
// Lazy-loaded chunk (same convention as builder.jsx): App.jsx imports this with
// lazy(), so importing CA / DISP / sbRead back from App.jsx is safe here.

import { useState, useEffect, useMemo } from "react";
import { CA, DISP, IS_DARK, sbRead, sbStatsRefresh, Skeleton, RangeControl } from "./App.jsx";
import { statsInRange, tonnageComparison, statsUnlocked, STATS_UNLOCK_SESSIONS } from "./stats.js";
import { displayStat, unitLabel, getDisplayUnit, LBS_PER_KG } from "./units.js";

const RANGE_WORDS = { "1W": "last 7 days", "1M": "last 30 days", "3M": "last 3 months", "1Y": "this past year" };
const RANGE_TITLES = { "1W": "Last 7 days", "1M": "Last 30 days", "3M": "Last 3 months", "1Y": "This past year" };
const fmtN = (n) => (Number(n) || 0).toLocaleString("en-US");
const fmtDay = (k) => k ? new Date(k + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
const fmtDayShort = (k) => k ? new Date(k + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
const fmtMonth = (m) => m ? new Date(m + "-15T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" }) : "";
const fmtHours = (s) => { const h = (Number(s) || 0) / 3600; return h >= 10 ? `${Math.round(h)} h` : `${Math.round(h * 10) / 10} h`; };
const tonnageDisp = (lbs) => fmtN(displayStat(lbs));

// THE number color (Will 10-02: every figure bold, in one on-brand color that is
// not the body ink). Light: the brand's single accent, forest. Dark: its cyan.
export const NUM_COLOR = IS_DARK ? CA.cyan : CA.green;
const num = { color: NUM_COLOR, fontWeight: 700, fontVariantNumeric: "tabular-nums" };

// Read the athlete's summary row. null while loading, {} when the row does not
// exist yet. Self-heal: when the row is missing, or its session count is behind
// the header's (athletes.total_sessions_logged, the same grouping), ask the
// server to recompute once. Covers a direct-SQL write (the QA reseed), a failed
// background refresh, and the first open after the table shipped.
export function useAthleteStats(athlete, tick = 0) {
  const [row, setRow] = useState(null);
  const athleteId = athlete?.id;
  const headerSessions = Number(athlete?.total_sessions_logged) || 0;
  useEffect(() => {
    let on = true;
    setRow(null);
    (async () => {
      let r = {};
      try { const rows = await sbRead("athlete_stats", `?athlete_id=eq.${athleteId}&select=stats,computed_at`); r = Array.isArray(rows) && rows[0] ? rows[0] : {}; } catch (_) {}
      const have = Number(r?.stats?.lifetime?.sessions) || 0;
      if (headerSessions > 0 && have !== headerSessions) {
        try { const fresh = await sbStatsRefresh(); if (Array.isArray(fresh) && fresh[0]) r = fresh[0]; } catch (_) {}
      }
      if (on) setRow(r);
    })();
    return () => { on = false; };
  }, [athleteId, headerSessions, tick]);
  return row;
}

// ── shared bits ──────────────────────────────────────────────────────────────
const card = (extra) => ({ background: CA.navy2, border: `1px solid ${CA.border}`, borderRadius: 12, padding: 14, marginBottom: 10, ...extra });
const lbl = { color: CA.muted, fontSize: 10, letterSpacing: 1.2, fontWeight: 600, textTransform: "uppercase" };
const big = { ...DISP, fontSize: 42, lineHeight: 1, ...num };
const Tile = ({ n, l, s }) => (
  <div style={{ background: CA.navy2, border: `1px solid ${CA.border}`, borderRadius: 12, padding: "12px 6px", textAlign: "center", minWidth: 0 }}>
    <div style={{ ...DISP, fontSize: 26, lineHeight: 1, ...num }}>{n}</div>
    <div style={{ ...lbl, fontSize: 9.5, marginTop: 4 }}>{l}</div>
    {s && <div style={{ color: CA.faint, fontSize: 10.5, marginTop: 2 }}>{s}</div>}
  </div>
);
const Fact = ({ k, v }) => (
  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "8px 0", borderTop: `1px solid ${CA.border}`, fontSize: 12.5, color: CA.text }}>
    <span>{k}</span><span style={{ ...num, textAlign: "right", whiteSpace: "nowrap" }}>{v}</span>
  </div>
);

// ── the Stats tab ────────────────────────────────────────────────────────────
export function StatsTab({ athlete, refreshTick = 0 }) {
  const row = useAthleteStats(athlete, refreshTick);
  const stats = row && row.stats ? row.stats : null;
  const [range, setRange] = useState("1Y");
  const unit = getDisplayUnit();
  const view = useMemo(() => statsInRange(stats, range), [stats, range]);
  const cmp = tonnageComparison(view.tonnage, { unit });
  const unlocked = statsUnlocked(stats);
  const favorites = useMemo(() => view.lifts.filter((l) => l.name && !/unknown/i.test(l.name)).slice(0, 3), [view]);
  const top = favorites[0];
  const best = view.best_lift;
  const L = stats?.lifetime;

  if (row === null) return <div style={{ padding: "8px 0" }}><Skeleton lines={[40, 90, 70, 60]} /></div>;
  if (!L || L.sessions === 0) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", padding: "40px 24px", color: CA.muted, fontSize: 13, lineHeight: 1.7 }}>
        <div style={{ fontSize: 40, marginBottom: 14 }}>📊</div>
        <div>Your numbers start with your first logged session. Every set you log from here on counts.</div>
      </div>
    );
  }

  return (
    <div>
      <RangeControl value={range} onChange={setRange} style={{ marginBottom: 12 }} />

      <div style={card()}>
        <div style={lbl}>{unitLabel(unit) === "kg" ? "Kilos" : "Pounds"} moved · {RANGE_WORDS[range]}</div>
        <div style={{ ...big, marginTop: 6 }}>{tonnageDisp(view.tonnage)}<span style={{ fontSize: 15, color: CA.muted, fontFamily: "'Inter'", fontWeight: 600, marginLeft: 4 }}>{unitLabel(unit)}</span></div>
        <div style={{ color: CA.text, fontSize: 12.5, lineHeight: 1.45, marginTop: 8 }}>
          {cmp ? <>That is <b style={num}>{cmp.text}</b>, moved one rep at a time.</> : view.tonnage > 0 ? "Every rep is in there." : `No weighted sets ${RANGE_WORDS[range]} yet.`}
        </div>
        {cmp && <div style={{ color: CA.faint, fontSize: 10.5, marginTop: 4 }}>{cmp.object} is about {fmtN(cmp.objectWeight)} {unitLabel(unit)}.</div>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 10 }}>
        <Tile n={fmtN(view.sessions)} l="Sessions logged" />
        <Tile n={fmtN(view.prs)} l="PRs hit" />
        <Tile n={fmtN(view.sets)} l="Sets" />
      </div>

      {unlocked ? (
        <>
          {best && (
            <div style={card()}>
              <div style={lbl}>Best lift · {RANGE_WORDS[range]}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
                <span style={{ ...DISP, fontSize: 32, lineHeight: 1, ...num }}>{displayStat(best.e1rm)}<span style={{ fontSize: 12, color: CA.muted, fontFamily: "'Inter'", fontWeight: 600, marginLeft: 3 }}>{unitLabel(unit)}</span></span>
                <span style={{ fontSize: 13, color: CA.text, fontWeight: 600 }}>{best.name}</span>
              </div>
              <div style={{ color: CA.faint, fontSize: 10.5, marginTop: 6 }}>Best estimated max{best.heaviest ? <>. Heaviest set: <b style={num}>{displayStat(best.heaviest)} {unitLabel(unit)}</b></> : ""}.</div>
            </div>
          )}
          {top && (
            <div style={card()}>
              <div style={lbl}>Favorite exercise · by sets</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 8 }}>
                {favorites.map((l, i) => (
                  <div key={l.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, color: CA.text, fontWeight: i === 0 ? 700 : 400 }}>
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</span>
                      <span style={{ ...num, fontSize: 12, whiteSpace: "nowrap", opacity: i === 0 ? 1 : 0.8 }}>{fmtN(l.sets)} sets</span>
                    </div>
                    <div style={{ height: 4, background: CA.border, borderRadius: 2, overflow: "hidden", marginTop: 4 }}><div style={{ width: `${Math.max(4, Math.round(100 * l.sets / top.sets))}%`, height: "100%", background: NUM_COLOR }} /></div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div style={{ border: `1px dashed ${CA.line2}`, borderRadius: 12, padding: 14, marginBottom: 10, fontSize: 12.5, color: CA.text, lineHeight: 1.5 }}>
          <b style={{ color: NUM_COLOR }}>Best lift and favorite exercise unlock at {STATS_UNLOCK_SESSIONS} sessions.</b>
          <div style={{ color: CA.muted }}>{STATS_UNLOCK_SESSIONS - L.sessions} to go.</div>
        </div>
      )}

      <div style={card()}>
        <div style={{ ...lbl, marginBottom: 2 }}>{RANGE_TITLES[range]}</div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {view.biggest_session && view.biggest_session.tonnage > 0 && <Fact k="Biggest session" v={`${tonnageDisp(view.biggest_session.tonnage)} ${unitLabel(unit)} · ${fmtDayShort(view.biggest_session.d)}`} />}
          <Fact k="Total reps" v={fmtN(view.reps)} />
          {view.duration_s > 0 && <Fact k="Time spent working out" v={fmtHours(view.duration_s)} />}
          {view.runs > 0 && <Fact k="Runs" v={`${fmtN(view.runs)}${view.miles > 0 ? ` · ${fmtN(Math.round(view.miles * 10) / 10)} mi` : ""}`} />}
        </div>
      </div>

      {/* Career: lifetime, never moves with the range. */}
      <div style={card({ background: CA.navy3 })}>
        <div style={{ ...lbl, marginBottom: 2 }}>Career · since {fmtMonth((L.first_day || "").slice(0, 7))}</div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <Fact k={`${unitLabel(unit) === "kg" ? "Kilos" : "Pounds"} moved`} v={tonnageDisp(L.tonnage)} />
          <Fact k="Sessions logged" v={fmtN(L.sessions)} />
          <Fact k="PRs hit" v={fmtN(L.prs)} />
          <Fact k="First log" v={fmtDay(L.first_day)} />
          <Fact k="Longest streak" v={L.longest_streak_weeks ? `${L.longest_streak_weeks} week${L.longest_streak_weeks === 1 ? "" : "s"}${L.current_streak_weeks >= L.longest_streak_weeks && L.current_streak_weeks > 1 ? ", still going" : ""}` : "—"} />
          {L.biggest_month && <Fact k="Biggest month" v={`${fmtMonth(L.biggest_month.m)} · ${L.biggest_month.sessions} sessions`} />}
          {L.duration_s > 0 && <Fact k="Time spent working out" v={fmtHours(L.duration_s)} />}
        </div>
      </div>

      <div style={{ color: CA.faint, fontSize: 10.5, lineHeight: 1.5, marginTop: 4 }}>Working sets only. Warm-ups and bodyweight-only moves add sets and reps, not weight. PRs are the ones you hit on WILCO, never a signup baseline. Time counts workouts started in the app.</div>
    </div>
  );
}

// ── the Proof feed's BY THE NUMBERS block ────────────────────────────────────
// A section of every edition (content_json.sections[i].numbers, built by
// api/trigger-proof-feed.js from the athlete_stats row). The opened letter
// draws it as this grid right after the rank hero; every other surface prints
// the section's label + body like any section.
export function ProofNumbersBlock({ section }) {
  const n = section?.numbers;
  if (!n || !(n.sessions > 0)) return null;
  const unit = n.unit === "kg" ? "kg" : "lbs";
  const month = n.period === "month";
  const prevWord = month ? "last month" : "last week";
  const tonIn = (lbs) => (unit === "kg" ? Math.round(lbs / LBS_PER_KG) : lbs);
  const delta = (cur, prev) => {
    if (!(prev > 0)) return null;
    const p = Math.round(((cur - prev) / prev) * 100);
    return p === 0 ? { t: `even with ${prevWord}`, up: null } : { t: `${p > 0 ? "▲" : "▼"} ${Math.abs(p)}% vs ${prevWord}`, up: p > 0 };
  };
  const sessDelta = n.sessions_prev > 0 ? (() => { const d = n.sessions - n.sessions_prev; return d === 0 ? { t: `same as ${prevWord}`, up: null } : { t: `${d > 0 ? "▲" : "▼"} ${Math.abs(d)} vs ${prevWord}`, up: d > 0 }; })() : null;
  const cells = [
    { v: fmtN(tonIn(n.tonnage)), l: `${unit === "kg" ? "kg" : "lb"} moved`, d: delta(n.tonnage, n.tonnage_prev) },
    { v: fmtN(n.sessions), l: "Sessions logged", d: sessDelta },
    { v: fmtN(n.sets), l: "Sets", d: delta(n.sets, n.sets_prev) },
    { v: fmtN(n.reps), l: "Reps", d: delta(n.reps, n.reps_prev) },
    { v: fmtN(n.prs), l: `PR${n.prs === 1 ? "" : "s"} hit`, d: n.best_lift ? { t: `Best: ${n.best_lift.name}`, up: null } : null },
    { v: n.favorite ? n.favorite : "—", l: "Most sets", d: n.favorite ? { t: `${fmtN(n.favorite_sets)} sets`, up: null } : null, text: true },
  ];
  const cmp = n.comparison;
  return (
    <div className="proof-drop" style={{ borderRadius: 14, padding: 14, marginBottom: 12, background: CA.navy3, border: `1px solid ${CA.border}` }}>
      <div style={{ fontSize: 9.5, letterSpacing: 2, textTransform: "uppercase", color: CA.amber, fontWeight: 700, marginBottom: 10 }}>By the numbers · {month ? "this month" : "this week"}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {cells.map((c, i) => (
          <div key={i} style={{ border: `1px solid ${CA.border}`, borderRadius: 8, padding: "8px 10px", background: CA.navy2, minWidth: 0 }}>
            <div style={{ ...DISP, fontSize: c.text ? 16 : 22, lineHeight: 1.1, ...num, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.v}</div>
            <div style={{ ...lbl, fontSize: 9.5, marginTop: 3 }}>{c.l}</div>
            {c.d && <div style={{ fontSize: 10.5, fontWeight: 600, marginTop: 2, color: c.d.up === true ? CA.green : c.d.up === false ? CA.red : CA.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.d.t}</div>}
          </div>
        ))}
      </div>
      {cmp && <div style={{ fontSize: 12.5, color: CA.text, lineHeight: 1.5, marginTop: 10 }}>That is <b style={num}>{cmp.text}</b> {month ? "this month" : "this week"}.</div>}
    </div>
  );
}
