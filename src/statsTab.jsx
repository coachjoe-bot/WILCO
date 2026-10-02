// ─── T70 STATS — the Stats tab, the share card, the monthly numbers block and
// the coach team-totals card ────────────────────────────────────────────────
// Every number here comes from the athlete_stats row the server keeps
// (src/stats.js computeAthleteStats, refreshed after every workouts write), read
// through the gateway like any other athlete table. Nothing is summed from raw
// workout rows on the phone, so a 500-log history costs one small read.
//
// Will's rulings (10-02): Stats lives in My Log between Workouts and Proof and is
// separate from Progress · best lift = highest Grit tier for size and age, the
// heaviest weight under it · favorite exercise by sets · signup baselines never
// count as PRs · one object comparison per total · a 9:16 share card (lifetime
// and this month) · the coach side gets team totals only · one range control
// drives Stats (opens ALL) and every graph (opens 3M).
//
// Lazy-loaded chunk (same convention as builder.jsx): App.jsx imports this with
// lazy(), so importing CA / DISP / sbRead back from App.jsx is safe here.

import { useState, useEffect, useMemo } from "react";
import { CA, DISP, IS_DARK, sbRead, haptic, Skeleton, RangeControl } from "./App.jsx";
import { statsInRange, tonnageComparison, statsUnlocked, STATS_UNLOCK_SESSIONS, RANGES } from "./stats.js";
import { resolveLift, getBenchKey, BENCH_THRESHOLDS, scaledThresholds, tierForRatio, ageTierFactor, TIER_NAMES, TIER_COLORS } from "./grit.js";
import { displayStat, unitLabel, getDisplayUnit } from "./units.js";
import { isNativeIOS } from "./platform.js";

const RANGE_WORDS = { "1M": "last 30 days", "3M": "last 3 months", "1Y": "last year", "ALL": "on WILCO" };
const fmtN = (n) => (Number(n) || 0).toLocaleString("en-US");
const fmtDay = (k) => k ? new Date(k + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
const fmtDayShort = (k) => k ? new Date(k + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
const fmtMonth = (m) => m ? new Date(m + "-15T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" }) : "";
const fmtHours = (s) => { const h = (Number(s) || 0) / 3600; return h >= 10 ? `${Math.round(h)} h` : `${Math.round(h * 10) / 10} h`; };
// A tonnage in the display unit, rounded like every other stat.
const tonnageDisp = (lbs) => fmtN(displayStat(lbs));

// Read the athlete's summary row. null while loading, {} when the row does not
// exist yet (a brand-new athlete, or the refresh is still in flight).
export function useAthleteStats(athleteId, tick = 0) {
  const [row, setRow] = useState(null);
  useEffect(() => {
    let on = true;
    setRow(null);
    sbRead("athlete_stats", `?athlete_id=eq.${athleteId}&select=stats,computed_at`)
      .then((rows) => { if (on) setRow(Array.isArray(rows) && rows[0] ? rows[0] : {}); })
      .catch(() => { if (on) setRow({}); });
    return () => { on = false; };
  }, [athleteId, tick]);
  return row;
}

// ── best lift for your size and age ──────────────────────────────────────────
// The same scaling the Benchmarks tab uses (BENCH_THRESHOLDS × bodyweight ×
// gender × age). Without a bodyweight there is no tier, so the heaviest e1RM
// wins instead and the chip says so.
export function bestLiftByTier(lifts, athlete) {
  const bw = Number(athlete?.weight_lbs) || 0;
  const genderKey = athlete?.gender === "Female" ? "female" : "male";
  const age = athlete?.birthday ? Math.floor((Date.now() - new Date(athlete.birthday)) / (365.25 * 864e5)) : (athlete?.age || null);
  let best = null;
  for (const l of lifts || []) {
    if (!l.tracked || !(l.e1rm > 0)) continue;
    let tierIdx = -1;
    if (bw) {
      const benchKey = getBenchKey(l.id);
      const raw = benchKey ? BENCH_THRESHOLDS[genderKey]?.[benchKey] : null;
      if (raw) tierIdx = tierForRatio(l.e1rm / bw, scaledThresholds(raw, bw, genderKey, age));
    }
    const cand = { ...l, tierIdx };
    if (!best || cand.tierIdx > best.tierIdx || (cand.tierIdx === best.tierIdx && cand.e1rm > best.e1rm)) best = cand;
  }
  return best;
}

// ── shared bits ──────────────────────────────────────────────────────────────
const card = (extra) => ({ background: CA.navy2, border: `1px solid ${CA.border}`, borderRadius: 12, padding: 14, marginBottom: 10, ...extra });
const lbl = { color: CA.muted, fontSize: 10, letterSpacing: 1.2, fontWeight: 600, textTransform: "uppercase" };
const big = { ...DISP, fontSize: 42, lineHeight: 1, color: CA.accent, fontVariantNumeric: "tabular-nums" };
const Tile = ({ n, l, s }) => (
  <div style={{ background: CA.navy2, border: `1px solid ${CA.border}`, borderRadius: 12, padding: "12px 6px", textAlign: "center", minWidth: 0 }}>
    <div style={{ ...DISP, fontSize: 26, lineHeight: 1, color: CA.accent, fontVariantNumeric: "tabular-nums" }}>{n}</div>
    <div style={{ ...lbl, fontSize: 9.5, marginTop: 4 }}>{l}</div>
    {s && <div style={{ color: CA.faint, fontSize: 10.5, marginTop: 2 }}>{s}</div>}
  </div>
);
const Fact = ({ k, v }) => (
  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "8px 0", borderTop: `1px solid ${CA.border}`, fontSize: 12.5, color: CA.text }}>
    <span>{k}</span><span style={{ color: CA.muted, textAlign: "right", whiteSpace: "nowrap" }}>{v}</span>
  </div>
);
const Btn = ({ children, onClick, ghost, style }) => (
  <button onClick={onClick} style={{ width: "100%", background: ghost ? "transparent" : CA.accent, color: ghost ? CA.accent : CA.onAccent, border: ghost ? `1px solid ${CA.accent}` : "none", borderRadius: 10, padding: 11, fontSize: 12, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", cursor: "pointer", fontFamily: "'Inter'", ...style }}>{children}</button>
);

// ── the Stats tab ────────────────────────────────────────────────────────────
export function StatsTab({ athlete, refreshTick = 0 }) {
  const row = useAthleteStats(athlete.id, refreshTick);
  const stats = row && row.stats ? row.stats : null;
  const [range, setRange] = useState("ALL");
  const [shareMsg, setShareMsg] = useState("");
  const unit = getDisplayUnit();
  const view = useMemo(() => statsInRange(stats, range), [stats, range]);
  const cmp = tonnageComparison(view.tonnage, { unit });
  const unlocked = statsUnlocked(stats);
  const best = useMemo(() => bestLiftByTier(view.lifts, athlete), [view, athlete]);
  const favorites = useMemo(() => view.lifts.filter((l) => l.name && !/unknown/i.test(l.name)).slice(0, 3), [view]);
  const top = favorites[0];
  const isAll = range === "ALL";
  const first = athlete?.name ? athlete.name.split(" ")[0] : "";

  if (row === null) return <div style={{ padding: "8px 0" }}><Skeleton lines={[40, 90, 70, 60]} /></div>;
  if (!stats || !stats.lifetime || stats.lifetime.sessions === 0) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", padding: "40px 24px", color: CA.muted, fontSize: 13, lineHeight: 1.7 }}>
        <div style={{ fontSize: 40, marginBottom: 14 }}>📊</div>
        <div>Your numbers start with your first logged session. Every set you log from here on counts.</div>
      </div>
    );
  }

  const share = async () => {
    haptic(15);
    try {
      const blob = await buildStatsCard({
        kicker: isAll ? `Pounds moved on WILCO` : `${RANGE_WORDS[range]}`,
        big: tonnageDisp(view.tonnage), unit: unitLabel(unit),
        line: cmp ? `${cmp.text}, one rep at a time.` : `${fmtN(view.sessions)} sessions in the books.`,
        cells: [{ v: fmtN(view.sessions), l: "Sessions" }, { v: fmtN(view.prs), l: "PRs" }, best ? { v: `${displayStat(best.e1rm)}`, l: `${best.name} est.` } : { v: fmtN(view.sets), l: "Sets" }],
        foot: `${first} · ${isAll ? `since ${fmtMonth((stats.lifetime.first_day || "").slice(0, 7))}` : RANGE_WORDS[range]} · trainwilco.com`,
      });
      const r = await shareImage(blob, `wilco-stats-${range.toLowerCase()}.png`);
      if (r === "saved") { setShareMsg("Saved. Post it wherever you like."); setTimeout(() => setShareMsg(""), 2600); }
    } catch (e) { setShareMsg("Couldn't build the card. Try again."); setTimeout(() => setShareMsg(""), 2600); }
  };

  return (
    <div>
      <RangeControl value={range} onChange={setRange} style={{ marginBottom: 12 }} />

      <div style={card()}>
        <div style={lbl}>{unitLabel(unit) === "kg" ? "Kilos" : "Pounds"} moved · {RANGE_WORDS[range]}</div>
        <div style={{ ...big, marginTop: 6 }}>{tonnageDisp(view.tonnage)}<span style={{ fontSize: 15, color: CA.muted, fontFamily: "'Inter'", fontWeight: 600, marginLeft: 4 }}>{unitLabel(unit)}</span></div>
        <div style={{ color: CA.text, fontSize: 12.5, lineHeight: 1.45, marginTop: 8 }}>
          {cmp ? <>That is <b style={{ color: CA.accent }}>{cmp.text}</b>, moved one rep at a time.</> : view.tonnage > 0 ? `Every rep is in there.` : `No weighted sets ${RANGE_WORDS[range]} yet.`}
        </div>
        {cmp && <div style={{ color: CA.faint, fontSize: 10.5, marginTop: 4 }}>{cmp.object} is about {fmtN(cmp.objectWeight)} {unitLabel(unit)}.</div>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 10 }}>
        <Tile n={fmtN(view.sessions)} l="Sessions" />
        <Tile n={fmtN(view.prs)} l="PRs hit" />
        <Tile n={fmtN(view.sets)} l="Sets" />
      </div>

      {unlocked ? (
        <>
          {best && (
            <div style={card()}>
              <div style={lbl}>Best lift · {best.tierIdx >= 0 ? "for your size and age" : "heaviest estimate"}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
                {best.tierIdx >= 0 && <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.6, textTransform: "uppercase", color: TIER_COLORS[best.tierIdx], border: `1px solid ${TIER_COLORS[best.tierIdx]}`, borderRadius: 5, padding: "3px 8px" }}>{TIER_NAMES[best.tierIdx]}</span>}
                <span style={{ ...DISP, fontSize: 32, lineHeight: 1, color: CA.text }}>{displayStat(best.e1rm)}<span style={{ fontSize: 12, color: CA.muted, fontFamily: "'Inter'", fontWeight: 600, marginLeft: 3 }}>{unitLabel(unit)}</span></span>
                <span style={{ fontSize: 13, color: CA.text, fontWeight: 600 }}>{best.name}</span>
              </div>
              <div style={{ color: CA.faint, fontSize: 10.5, marginTop: 6 }}>Best estimated max{best.heaviest ? `. Heaviest set: ${displayStat(best.heaviest)} ${unitLabel(unit)}` : ""}{best.tierIdx < 0 ? ". Add your bodyweight in Settings for a rank." : ""}.</div>
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
                      <span style={{ fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", fontSize: 12, color: i === 0 ? CA.accent : CA.muted, fontWeight: i === 0 ? 700 : 400, whiteSpace: "nowrap" }}>{fmtN(l.sets)} sets</span>
                    </div>
                    <div style={{ height: 4, background: CA.border, borderRadius: 2, overflow: "hidden", marginTop: 4 }}><div style={{ width: `${Math.max(4, Math.round(100 * l.sets / top.sets))}%`, height: "100%", background: CA.accent }} /></div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div style={{ border: `1px dashed ${CA.line2}`, borderRadius: 12, padding: 14, marginBottom: 10, fontSize: 12.5, color: CA.text, lineHeight: 1.5 }}>
          <b style={{ color: CA.accent }}>Best lift, favorite exercise and the share card unlock at {STATS_UNLOCK_SESSIONS} sessions.</b>
          <div style={{ color: CA.muted }}>{STATS_UNLOCK_SESSIONS - stats.lifetime.sessions} to go.</div>
        </div>
      )}

      <div style={card()}>
        <div style={{ ...lbl, marginBottom: 2 }}>{isAll ? "Career" : RANGE_WORDS[range]}</div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {isAll && <Fact k="First log" v={fmtDay(stats.lifetime.first_day)} />}
          {isAll
            ? <Fact k="Longest streak" v={stats.lifetime.longest_streak_weeks ? `${stats.lifetime.longest_streak_weeks} week${stats.lifetime.longest_streak_weeks === 1 ? "" : "s"}${stats.lifetime.current_streak_weeks >= stats.lifetime.longest_streak_weeks && stats.lifetime.current_streak_weeks > 1 ? ", still going" : ""}` : "—"} />
            : <Fact k="Streak" v={stats.lifetime.current_streak_weeks ? `${stats.lifetime.current_streak_weeks} week${stats.lifetime.current_streak_weeks === 1 ? "" : "s"}, still going` : "none right now"} />}
          {isAll && stats.lifetime.biggest_month && <Fact k="Biggest month" v={`${fmtMonth(stats.lifetime.biggest_month.m)} · ${stats.lifetime.biggest_month.sessions} sessions`} />}
          {view.biggest_session && view.biggest_session.tonnage > 0 && <Fact k="Biggest session" v={`${tonnageDisp(view.biggest_session.tonnage)} ${unitLabel(unit)} · ${fmtDayShort(view.biggest_session.d)}`} />}
          <Fact k="Total reps" v={fmtN(view.reps)} />
          {view.duration_s > 0 && <Fact k="Time under the bar" v={fmtHours(view.duration_s)} />}
          {view.runs > 0 && <Fact k="Runs" v={`${fmtN(view.runs)}${view.miles > 0 ? ` · ${fmtN(Math.round(view.miles * 10) / 10)} mi` : ""}`} />}
          <Fact k="Training days" v={fmtN(view.training_days)} />
        </div>
      </div>

      {unlocked && <Btn onClick={share}>{isAll ? "Share my stats" : `Share ${RANGE_WORDS[range]}`}</Btn>}
      {shareMsg && <div style={{ color: CA.muted, fontSize: 11.5, textAlign: "center", marginTop: 8 }}>{shareMsg}</div>}
      <div style={{ color: CA.faint, fontSize: 10.5, lineHeight: 1.5, marginTop: 12 }}>Working sets only. Warm-ups and bodyweight-only moves add sets and reps, not weight. PRs are the ones you hit on WILCO, never a signup baseline.</div>
    </div>
  );
}

// ── the share card (9:16, brand navy, same in both themes) ──────────────────
// Drawn on a canvas so it exports as one image: the OS share sheet on iOS, the
// web share sheet where the browser has one, a saved file otherwise.
const CARD_NAVY = "#28508B", CARD_INK = "#F7F4EF";
const roundRect = (ctx, x, y, w, h, r) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); };
const wrapText = (ctx, text, maxW) => {
  const words = String(text || "").split(/\s+/); const lines = []; let cur = "";
  for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur); return lines;
};
export async function buildStatsCard({ kicker, big, unit, line, cells = [], foot, title = "WILCO" }) {
  const W = 1080, H = 1920, P = 96;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  try { await document.fonts?.load("800 160px Inter"); await document.fonts?.load("600 40px Inter"); } catch (_) {}
  ctx.fillStyle = CARD_NAVY; ctx.fillRect(0, 0, W, H);
  // faint grid, the app's journal paper
  ctx.strokeStyle = "rgba(247,244,239,0.07)"; ctx.lineWidth = 2;
  for (let y = 0; y < H; y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.fillStyle = CARD_INK; ctx.textBaseline = "top";
  ctx.font = "800 64px Inter, system-ui, sans-serif"; ctx.letterSpacing = "10px"; ctx.fillText(title, P, P);
  ctx.letterSpacing = "0px";
  // kicker + big number sit in the middle third
  let y = 660;
  ctx.font = "600 34px Inter, system-ui, sans-serif"; ctx.globalAlpha = 0.8; ctx.letterSpacing = "6px"; ctx.fillText(String(kicker || "").toUpperCase(), P, y); ctx.globalAlpha = 1; ctx.letterSpacing = "0px";
  y += 70;
  ctx.font = "800 190px Inter, system-ui, sans-serif";
  let bigText = String(big); while (ctx.measureText(bigText).width > W - 2 * P - 160 && parseInt(ctx.font) > 100) ctx.font = `800 ${parseInt(ctx.font) - 10}px Inter, system-ui, sans-serif`;
  ctx.fillText(bigText, P, y);
  const bw = ctx.measureText(bigText).width;
  ctx.font = "600 48px Inter, system-ui, sans-serif"; ctx.globalAlpha = 0.85; ctx.fillText(unit || "", P + bw + 18, y + 120); ctx.globalAlpha = 1;
  y += 230;
  ctx.font = "500 44px Inter, system-ui, sans-serif"; ctx.globalAlpha = 0.92;
  for (const l of wrapText(ctx, line, W - 2 * P)) { ctx.fillText(l, P, y); y += 58; }
  ctx.globalAlpha = 1;
  // cells
  const cy = 1380;
  ctx.strokeStyle = "rgba(247,244,239,0.35)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(P, cy); ctx.lineTo(W - P, cy); ctx.stroke();
  const cw = (W - 2 * P) / Math.max(1, cells.length);
  cells.forEach((cell, i) => {
    const x = P + i * cw;
    ctx.font = "800 80px Inter, system-ui, sans-serif"; ctx.fillText(String(cell.v), x, cy + 40);
    ctx.font = "600 26px Inter, system-ui, sans-serif"; ctx.globalAlpha = 0.8; ctx.letterSpacing = "4px"; ctx.fillText(String(cell.l).toUpperCase(), x, cy + 140); ctx.globalAlpha = 1; ctx.letterSpacing = "0px";
  });
  ctx.font = "600 28px Inter, system-ui, sans-serif"; ctx.globalAlpha = 0.7; ctx.letterSpacing = "4px"; ctx.fillText(String(foot || "").toUpperCase(), P, H - P - 30); ctx.globalAlpha = 1; ctx.letterSpacing = "0px";
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("no blob"))), "image/png"));
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1]); r.onerror = reject; r.readAsDataURL(blob); });
// "shared" | "saved" | "cancelled"
export async function shareImage(blob, filename) {
  if (isNativeIOS()) {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([import("@capacitor/filesystem"), import("@capacitor/share")]);
    const data = await blobToBase64(blob);
    const written = await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache });
    try { await Share.share({ title: "WILCO", files: [written.uri] }); return "shared"; }
    catch (_) { return "cancelled"; }
  }
  const file = new File([blob], filename, { type: "image/png" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "WILCO" }); return "shared"; }
    catch (_) { return "cancelled"; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return "saved";
}

// ── monthly Proof: BY THE NUMBERS block ──────────────────────────────────────
// `numbers` is computed on the server (api/trigger-proof-feed.js, from the
// athlete_stats row) and stored in content_json.numbers; Joe never does the
// math. Tonnage arrives in lbs and is shown in the display unit.
export function StatsNumbersBlock({ numbers, athleteName, monthLabel }) {
  const [msg, setMsg] = useState("");
  if (!numbers || !(numbers.sessions > 0)) return null;
  const unit = getDisplayUnit();
  const delta = (cur, prev, fmt = (x) => x) => {
    if (!(prev > 0)) return null;
    const pct = Math.round(((cur - prev) / prev) * 100);
    if (pct === 0) return { t: "even with last month", up: null };
    return { t: `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs last month`, up: pct > 0 };
  };
  const cmp = numbers.comparison || tonnageComparison(numbers.tonnage, { unit });
  const cells = [
    { v: tonnageDisp(numbers.tonnage), l: `${unitLabel(unit)} moved`, d: delta(numbers.tonnage, numbers.tonnage_prev) },
    { v: fmtN(numbers.sessions), l: "Sessions", d: numbers.sessions_prev > 0 ? { t: `${numbers.sessions - numbers.sessions_prev >= 0 ? "▲" : "▼"} ${Math.abs(numbers.sessions - numbers.sessions_prev)} vs last month`, up: numbers.sessions - numbers.sessions_prev > 0 ? true : numbers.sessions - numbers.sessions_prev < 0 ? false : null } : null },
    { v: fmtN(numbers.prs), l: "PRs hit", d: numbers.favorite ? { t: `Most sets: ${numbers.favorite}`, up: null } : null },
    { v: fmtN(numbers.reps), l: "Reps", d: delta(numbers.reps, numbers.reps_prev) },
  ];
  const share = async () => {
    haptic(15);
    try {
      const blob = await buildStatsCard({
        kicker: monthLabel || "This month", big: tonnageDisp(numbers.tonnage), unit: unitLabel(unit),
        line: cmp ? `${cmp.text}${numbers.tonnage_prev > 0 ? `. ${delta(numbers.tonnage, numbers.tonnage_prev)?.t.replace(/[▲▼] /, (m) => (m === "▲ " ? "Up " : "Down "))}` : ""}.` : `${numbers.sessions} sessions in the books.`,
        cells: [{ v: fmtN(numbers.sessions), l: "Sessions" }, { v: fmtN(numbers.prs), l: "PRs" }, numbers.best_lift ? { v: `${displayStat(numbers.best_lift.e1rm)}`, l: `${numbers.best_lift.name} est.` } : { v: fmtN(numbers.sets || 0), l: "Sets" }],
        foot: `${(athleteName || "").split(" ")[0]} · ${monthLabel || ""} · trainwilco.com`,
      });
      const r = await shareImage(blob, "wilco-month.png");
      if (r === "saved") { setMsg("Saved."); setTimeout(() => setMsg(""), 2000); }
    } catch (_) { setMsg("Couldn't build the card."); setTimeout(() => setMsg(""), 2000); }
  };
  return (
    <div className="proof-drop" style={{ borderRadius: 14, padding: 14, marginBottom: 12, background: CA.navy3, border: `1px solid ${CA.border}` }}>
      <div style={{ fontSize: 9.5, letterSpacing: 2, textTransform: "uppercase", color: CA.amber, fontWeight: 700, marginBottom: 10 }}>By the numbers</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {cells.map((c, i) => (
          <div key={i} style={{ border: `1px solid ${CA.border}`, borderRadius: 8, padding: "8px 10px", background: CA.navy2, minWidth: 0 }}>
            <div style={{ ...DISP, fontSize: 22, lineHeight: 1, color: CA.accent, fontVariantNumeric: "tabular-nums" }}>{c.v}</div>
            <div style={{ ...lbl, fontSize: 9.5, marginTop: 3 }}>{c.l}</div>
            {c.d && <div style={{ fontSize: 10.5, fontWeight: 600, marginTop: 2, color: c.d.up === true ? CA.green : c.d.up === false ? CA.red : CA.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.d.t}</div>}
          </div>
        ))}
      </div>
      {cmp && <div style={{ fontSize: 12.5, color: CA.text, lineHeight: 1.5, marginTop: 10 }}>That is <b style={{ color: CA.accent }}>{cmp.text}</b> this month.</div>}
      <Btn onClick={share} style={{ marginTop: 10 }}>Share {monthLabel || "this month"}</Btn>
      {msg && <div style={{ color: CA.muted, fontSize: 11, textAlign: "center", marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

// ── coach: TEAM TOTALS ───────────────────────────────────────────────────────
// Sums the roster's athlete_stats rows (the gateway scopes the read to this
// coach's athletes). No per-athlete stats surface on the coach side (Will).
export function TeamStatsCard({ athletes, teamName }) {
  const [rows, setRows] = useState(null);
  const [range, setRange] = useState("3M");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    let on = true;
    sbRead("athlete_stats", "?select=athlete_id,stats").then((r) => { if (on) setRows(Array.isArray(r) ? r : []); }).catch(() => { if (on) setRows([]); });
    return () => { on = false; };
  }, [(athletes || []).length]);
  const ids = useMemo(() => new Set((athletes || []).map((a) => a.id)), [athletes]);
  const agg = useMemo(() => {
    const out = { tonnage: 0, sessions: 0, prs: 0, sets: 0, logged: 0, lifts: new Map() };
    for (const r of rows || []) {
      if (ids.size && !ids.has(r.athlete_id)) continue;
      const v = statsInRange(r.stats, range);
      out.tonnage += v.tonnage; out.sessions += v.sessions; out.prs += v.prs; out.sets += v.sets;
      if (v.sessions > 0) out.logged++;
      for (const l of v.lifts) { const cur = out.lifts.get(l.id) || { id: l.id, name: l.name, sets: 0 }; cur.sets += l.sets; out.lifts.set(l.id, cur); }
    }
    out.top = [...out.lifts.values()].filter((l) => !/unknown/i.test(l.name)).sort((a, b) => b.sets - a.sets).slice(0, 3);
    return out;
  }, [rows, ids, range]);
  const unit = getDisplayUnit();
  const cmp = tonnageComparison(agg.tonnage, { unit });
  const n = (athletes || []).length;
  const share = async () => {
    try {
      const blob = await buildStatsCard({
        kicker: `${teamName || "The team"} · ${RANGE_WORDS[range]}`, big: tonnageDisp(agg.tonnage), unit: unitLabel(unit),
        line: cmp ? `${cmp.text}, as a team.` : `${agg.sessions} sessions as a team.`,
        cells: [{ v: fmtN(agg.sessions), l: "Sessions" }, { v: fmtN(agg.prs), l: "PRs" }, { v: `${agg.logged}/${n}`, l: "Logged" }],
        foot: `${teamName || "WILCO"} · trainwilco.com`,
      });
      const r = await shareImage(blob, "wilco-team.png");
      if (r === "saved") { setMsg("Saved."); setTimeout(() => setMsg(""), 2000); }
    } catch (_) { setMsg("Couldn't build the card."); setTimeout(() => setMsg(""), 2000); }
  };
  return (
    <div style={{ background: CA.navy2, border: `1px solid ${CA.border}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <div style={{ fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: CA.faint }}>Team totals</div>
        <RangeControl value={range} onChange={setRange} style={{ width: 220 }} />
      </div>
      {rows === null ? <Skeleton lines={[60, 90, 40]} /> : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)", gap: 14 }}>
          <div style={{ minWidth: 0 }}>
            <div style={lbl}>{unitLabel(unit) === "kg" ? "Kilos" : "Pounds"} moved · {RANGE_WORDS[range]}</div>
            <div style={{ ...big, fontSize: 40, marginTop: 6 }}>{tonnageDisp(agg.tonnage)}<span style={{ fontSize: 14, color: CA.muted, fontFamily: "'Inter'", fontWeight: 600, marginLeft: 4 }}>{unitLabel(unit)}</span></div>
            <div style={{ color: CA.text, fontSize: 12.5, lineHeight: 1.45, marginTop: 6 }}>{cmp ? <>That is <b style={{ color: CA.accent }}>{cmp.text}</b>.</> : "Nothing logged in this window yet."} {n ? `${agg.logged} of ${n} athletes logged.` : ""}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginTop: 12 }}>
              <Tile n={fmtN(agg.sessions)} l="Sessions" /><Tile n={fmtN(agg.prs)} l="PRs hit" /><Tile n={fmtN(agg.sets)} l="Sets" />
            </div>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={lbl}>Most trained · by sets</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 8 }}>
              {agg.top.length === 0 && <div style={{ color: CA.muted, fontSize: 12 }}>No sets in this window.</div>}
              {agg.top.map((l, i) => (
                <div key={l.id}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, color: CA.text, fontWeight: i === 0 ? 700 : 400 }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</span>
                    <span style={{ fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", fontSize: 11.5, color: i === 0 ? CA.accent : CA.muted, whiteSpace: "nowrap" }}>{fmtN(l.sets)}</span>
                  </div>
                  <div style={{ height: 4, background: CA.border, borderRadius: 2, overflow: "hidden", marginTop: 4 }}><div style={{ width: `${Math.max(4, Math.round(100 * l.sets / agg.top[0].sets))}%`, height: "100%", background: CA.accent }} /></div>
                </div>
              ))}
            </div>
            {agg.sessions > 0 && <Btn ghost onClick={share} style={{ marginTop: 12 }}>Share team card</Btn>}
            {msg && <div style={{ color: CA.muted, fontSize: 11, textAlign: "center", marginTop: 6 }}>{msg}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
