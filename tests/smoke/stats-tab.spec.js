// ─── T70 STATS (Will 10-02) ──────────────────────────────────────────────────
// MY LOG gets a Stats tab between Workouts and Proof: career numbers from the
// athlete_stats row the server keeps (src/stats.js), a 1M · 3M · 1Y · ALL range
// control that also drives every Progress graph, a share card, and a BY THE
// NUMBERS block inside the monthly Proof. The row is mocked here exactly as the
// server would write it: computed by the same function from synthetic logs.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete } from "./mocks.js";
import { computeAthleteStats, statsInRange, tonnageComparison } from "../../src/stats.js";

if (process.env.SHOTS) test.use({ viewport: { width: 430, height: 900 } });
const shot = async (page, name) => { if (process.env.SHOTS) { await page.waitForTimeout(350); await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); } };

const TZ = "America/New_York";
const daysAgo = (n, h = 16) => new Date(Date.now() - n * 864e5 - (16 - h) * 3600e3).toISOString();
let seq = 0;
const row = (athleteId, n, exercises, extra = {}) => ({
  id: `w${++seq}`, athlete_id: athleteId, created_at: daysAgo(n), raw_message: "logged",
  parsed_data: { exercises, pain_flags: [], ...(extra.parsed_data || {}) }, ...(extra.duration_seconds ? { duration_seconds: extra.duration_seconds } : {}),
});
const EX = (name, sets, reps, weight, unit = "lbs") => ({ name, sets, reps, weight, unit });

// A year of bench, squat and deadlift, one session every 6 days, loads climbing.
const yearOfLogs = (athleteId) => {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const n = 360 - i * 6;
    const bench = 155 + i, squat = 225 + i * 2, dead = 275 + i * 2;
    rows.push(row(athleteId, n, [EX("Bench Press", 4, 5, bench), EX("Back Squat", 3, 5, squat), ...(i % 2 ? [EX("Deadlift", 2, 5, dead)] : [EX("Pull-ups", 3, 8, 0, "bodyweight")])], { duration_seconds: 3600 }));
  }
  rows.push(row(athleteId, 20, [], { parsed_data: { exercises: [], run_data: { distance_miles: 3.1, pace_per_mile: "8:30" } } }));
  rows.push(row(athleteId, 13, [], { parsed_data: { exercises: [], run_data: { distance_miles: 4, pace_per_mile: "8:20" } } }));
  return rows;
};
const thinLogs = (athleteId) => [0, 3, 6, 9].map((n) => row(athleteId, n + 1, [EX("Bench Press", 3, 5, 135), EX("Back Squat", 3, 5, 185)]));

const statsRowFor = (athlete, rows) => [{ athlete_id: athlete.id, stats: computeAthleteStats(rows, { bodyweightLbs: athlete.weight_lbs, tz: TZ }), computed_at: new Date().toISOString() }];
const fmt = (n) => n.toLocaleString("en-US");

const openStats = async (page) => {
  await page.getByRole("button", { name: "MY LOG" }).click();
  await page.getByRole("button", { name: /^stats$/i }).click();
};

for (const theme of ["light", "dark"]) {
  test(`Stats tab: career numbers, best lift, favorite, facts, share (${theme})`, async ({ page }) => {
    const athlete = makeAthlete({ total_sessions_logged: 60 });
    const rows = yearOfLogs(athlete.id);
    const stats = statsRowFor(athlete, rows)[0].stats;
    await mockApi(page, { athlete, dataReads: { workouts: rows.slice(-40), athlete_stats: statsRowFor(athlete, rows), prs: [], manual_one_rms: [] } });
    if (theme === "dark") await page.addInitScript(() => { try { localStorage.setItem("wilco_theme", "dark"); } catch (_) {} });
    await loginAsAthlete(page, athlete);
    await openStats(page);

    // ALL time by default: lifetime tonnage with its comparison object.
    const all = statsInRange(stats, "ALL");
    // The hero number carries its unit in a child span, so match the text loosely.
    await expect(page.getByText(fmt(all.tonnage), { exact: false }).first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(tonnageComparison(all.tonnage).text, { exact: false })).toBeVisible();
    await expect(page.getByText("PRs hit", { exact: true })).toBeVisible();
    // Best lift by Grit tier (bodyweight 180 set): a tier chip and the lift name.
    await expect(page.getByText("Best lift", { exact: false })).toBeVisible();
    // Favorite by sets: bench has the most sets (4 per session).
    await expect(page.getByText("Favorite exercise", { exact: false })).toBeVisible();
    const fav = page.getByText(`${fmt(all.favorite.sets)} sets`, { exact: true });
    await expect(fav).toBeVisible();
    expect(all.favorite.name.toLowerCase()).toContain("bench");
    // Career facts.
    await expect(page.getByText("First log", { exact: true })).toBeVisible();
    await expect(page.getByText("Longest streak", { exact: true })).toBeVisible();
    await expect(page.getByText("Biggest month", { exact: true })).toBeVisible();
    await expect(page.getByText("Time under the bar", { exact: true })).toBeVisible();
    await expect(page.getByText("Runs", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /share my stats/i })).toBeVisible();
    await shot(page, `stats-all-${theme}`);

    // 1M: the hero rewrites to the last 30 days.
    await page.getByRole("tab", { name: "1M" }).click();
    const m1 = statsInRange(stats, "1M");
    expect(m1.tonnage).toBeLessThan(all.tonnage);
    await expect(page.getByText(fmt(m1.tonnage), { exact: false }).first()).toBeVisible();
    await expect(page.getByText("last 30 days", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /share last 30 days/i })).toBeVisible();
    await shot(page, `stats-1m-${theme}`);
  });
}

test("Stats tab: thin history keeps the unlock card and hides the share button", async ({ page }) => {
  const athlete = makeAthlete({ total_sessions_logged: 4 });
  const rows = thinLogs(athlete.id);
  await mockApi(page, { athlete, dataReads: { workouts: rows, athlete_stats: statsRowFor(athlete, rows), prs: [], manual_one_rms: [] } });
  await loginAsAthlete(page, athlete);
  await openStats(page);
  await expect(page.getByText(/unlock at 10 sessions/i)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("6 to go.")).toBeVisible();
  await expect(page.getByRole("button", { name: /share/i })).toHaveCount(0);
  await expect(page.getByText(/^Best lift ·/)).toHaveCount(0);
  await shot(page, "stats-thin");
});

test("Stats tab: no summary row yet shows the first-session state", async ({ page }) => {
  const athlete = makeAthlete({ total_sessions_logged: 0 });
  await mockApi(page, { athlete, dataReads: { workouts: [], athlete_stats: [], prs: [], manual_one_rms: [] } });
  await loginAsAthlete(page, athlete);
  await openStats(page);
  await expect(page.getByText(/Your numbers start with your first logged session/)).toBeVisible({ timeout: 15000 });
});

test("Progress graphs: one range control, 3M by default, ALL reads the weekly summary", async ({ page }) => {
  const athlete = makeAthlete({ total_sessions_logged: 60 });
  const rows = yearOfLogs(athlete.id);
  await mockApi(page, { athlete, dataReads: { workouts: rows.slice(-40), athlete_stats: statsRowFor(athlete, rows), prs: [], manual_one_rms: [] } });
  await loginAsAthlete(page, athlete);
  await page.getByRole("button", { name: "PROGRESS" }).click();
  await page.getByRole("button", { name: /^strength$/i }).click();
  const ctl = page.getByRole("tablist", { name: "Time range" });
  await expect(ctl).toBeVisible({ timeout: 15000 });
  await expect(ctl.getByRole("tab", { name: "3M" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(/logged \d+ times?/).first()).toBeVisible();
  await shot(page, "progress-strength-3m");
  await ctl.getByRole("tab", { name: "ALL" }).click();
  // Long range: one point per week from the summary, labelled as such.
  await expect(page.getByText(/\d+ weeks? · weekly best/).first()).toBeVisible();
  await shot(page, "progress-strength-all");
  // Running tab carries the same control; ALL charts miles per week.
  await page.getByRole("button", { name: /^running$/i }).click();
  await expect(page.getByRole("tablist", { name: "Time range" })).toBeVisible();
  await expect(page.getByText("Miles per week")).toBeVisible();
  await shot(page, "progress-running-all");
});

test("Monthly Proof: BY THE NUMBERS block renders from content_json.numbers with a share button", async ({ page }) => {
  const athlete = makeAthlete({ total_sessions_logged: 60 });
  const rows = yearOfLogs(athlete.id);
  const stats = statsRowFor(athlete, rows)[0].stats;
  const m = statsInRange(stats, "1M");
  const numbers = { tonnage: m.tonnage, tonnage_prev: Math.round(m.tonnage * 0.9), sessions: m.sessions, sessions_prev: m.sessions + 1, sets: m.sets, reps: m.reps, reps_prev: Math.round(m.reps * 0.95), prs: m.prs, favorite: m.favorite?.name || null, best_lift: m.best_lift ? { name: m.best_lift.name, e1rm: m.best_lift.e1rm } : null, comparison: tonnageComparison(m.tonnage) };
  const digest = {
    id: "d-monthly", athlete_id: athlete.id, digest_type: "monthly", is_read: false,
    generated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    label: "MONTHLY RECAP: September 2026",
    content_json: {
      intro: "Test, let's zoom out on the month.",
      sections: [
        { label: "GRIT RANK", body: "STRONG. Strength Score 770, up 50." },
        { label: "THIS MONTH VS LAST", body: "More weight moved on fewer sessions." },
        { label: "FOCUS NEXT WEEK", body: "Keep the bench climbing." },
      ],
      questions: [{ id: "recovery", kind: "context", deeper: false, text: "Recovery this month: dialed, flat, or running on fumes?" }],
      flags: {}, numbers,
    },
  };
  await mockApi(page, { athlete, dataReads: { workouts: rows.slice(-40), proof_digests: [digest], athlete_stats: statsRowFor(athlete, rows), prs: [], manual_one_rms: [] } });
  await loginAsAthlete(page, athlete);
  await page.getByRole("button", { name: "MY LOG" }).click();
  await page.getByRole("button", { name: /^proof$/i }).click();
  await page.getByText(/OPEN THIS (WEEK|MONTH)'S EDITION/).click();
  await expect(page.getByText("By the numbers")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(fmt(numbers.tonnage), { exact: true })).toBeVisible();
  await expect(page.getByText(/▲ 11% vs last month/)).toBeVisible();
  await expect(page.getByText(/▼ 1 vs last month/)).toBeVisible();
  await expect(page.getByRole("button", { name: /share september 2026/i })).toBeVisible();
  await shot(page, "proof-monthly-numbers");
});
