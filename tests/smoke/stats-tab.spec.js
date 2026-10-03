// ─── T70 STATS (Will 10-02, round 2) ─────────────────────────────────────────
// MY LOG gets a Stats tab between Workouts and Proof: career numbers from the
// athlete_stats row the server keeps (src/stats.js), a 1W · 1M · 3M · 1Y range
// control that also drives every Progress graph, and a BY THE NUMBERS section
// inside every Proof edition (weekly and monthly). No Grit rank on Stats, no
// share cards, nothing coach-side. The row is mocked here exactly as the server
// would write it: computed by the same function from synthetic logs.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete } from "./mocks.js";
import { computeAthleteStats, statsInRange, tonnageComparison, weekNumbers, monthNumbers, numbersSection, withNumbersSection } from "../../src/stats.js";

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

// A year of bench, squat and deadlift, one session every 3 days, loads climbing.
const yearOfLogs = (athleteId) => {
  const rows = [];
  for (let i = 0; i < 120; i++) {
    const n = 360 - i * 3;
    const bench = 155 + Math.floor(i / 2), squat = 225 + i, dead = 275 + i;
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
  test(`Stats tab: this past year, best lift, favorite, career card, no rank, no share (${theme})`, async ({ page }) => {
    const athlete = makeAthlete({ total_sessions_logged: 120 });
    const rows = yearOfLogs(athlete.id);
    const stats = statsRowFor(athlete, rows)[0].stats;
    await mockApi(page, { athlete, dataReads: { workouts: rows.slice(-40), athlete_stats: statsRowFor(athlete, rows), prs: [], manual_one_rms: [] } });
    if (theme === "dark") await page.addInitScript(() => { try { localStorage.setItem("wilco_theme", "dark"); } catch (_) {} });
    await loginAsAthlete(page, athlete);
    await openStats(page);

    // 1Y by default.
    const y = statsInRange(stats, "1Y");
    const ctl = page.getByRole("tablist", { name: "Time range" });
    await expect(ctl.getByRole("tab", { name: "1Y" })).toHaveAttribute("aria-selected", "true", { timeout: 15000 });
    await expect(ctl.getByRole("tab")).toHaveCount(4);
    await expect(page.getByText(fmt(y.tonnage), { exact: false }).first()).toBeVisible();
    await expect(page.getByText(tonnageComparison(y.tonnage).text, { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Sessions logged", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("PRs hit", { exact: true }).first()).toBeVisible();
    // Best lift: biggest estimated max, no tier chip.
    await expect(page.getByText(/^Best lift ·/)).toBeVisible();
    for (const tier of ["ROOKIE", "GRITTY", "SHARP", "STRONG", "ELITE", "DOMINANT", "UNTOUCHABLE", "LEGENDARY"]) await expect(page.getByText(tier, { exact: true })).toHaveCount(0);
    // Favorite by sets.
    await expect(page.getByText("Favorite exercise", { exact: false })).toBeVisible();
    await expect(page.getByText(`${fmt(y.favorite.sets)} sets`, { exact: true })).toBeVisible();
    expect(y.favorite.name.toLowerCase()).toContain("bench");
    // Range card: Will's words.
    await expect(page.getByText("This past year", { exact: true })).toBeVisible();
    await expect(page.getByText("Time spent working out", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Training days", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Time under the bar", { exact: true })).toHaveCount(0);
    // Career card: lifetime, with the first log and the streak.
    await expect(page.getByText(/^Career · since/)).toBeVisible();
    await expect(page.getByText("First log", { exact: true })).toBeVisible();
    await expect(page.getByText("Longest streak", { exact: true })).toBeVisible();
    await expect(page.getByText("Biggest month", { exact: true })).toBeVisible();
    // No sharing anywhere.
    await expect(page.getByRole("button", { name: /share/i })).toHaveCount(0);
    await shot(page, `stats-1y-${theme}`);

    // 1W: the top rewrites to the last 7 days, the Career card stays.
    await ctl.getByRole("tab", { name: "1W" }).click();
    const w = statsInRange(stats, "1W");
    expect(w.tonnage).toBeLessThan(y.tonnage);
    await expect(page.getByText(fmt(w.tonnage), { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Last 7 days", { exact: true })).toBeVisible();
    await expect(page.getByText(/^Career · since/)).toBeVisible();
    await shot(page, `stats-1w-${theme}`);
  });
}

test("Stats tab: thin history keeps the unlock card", async ({ page }) => {
  const athlete = makeAthlete({ total_sessions_logged: 4 });
  const rows = thinLogs(athlete.id);
  await mockApi(page, { athlete, dataReads: { workouts: rows, athlete_stats: statsRowFor(athlete, rows), prs: [], manual_one_rms: [] } });
  await loginAsAthlete(page, athlete);
  await openStats(page);
  await expect(page.getByText(/unlock at 10 sessions/i)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("6 to go.")).toBeVisible();
  await expect(page.getByText(/^Best lift ·/)).toHaveCount(0);
  await expect(page.getByText(/^Career · since/)).toBeVisible();
  await shot(page, "stats-thin");
});

test("Stats tab: no summary row yet shows the first-session state", async ({ page }) => {
  const athlete = makeAthlete({ total_sessions_logged: 0 });
  await mockApi(page, { athlete, dataReads: { workouts: [], athlete_stats: [], prs: [], manual_one_rms: [] } });
  await loginAsAthlete(page, athlete);
  await openStats(page);
  await expect(page.getByText(/Your numbers start with your first logged session/)).toBeVisible({ timeout: 15000 });
});

test("Progress graphs: one range control, 3M by default, 1Y reads the weekly summary", async ({ page }) => {
  const athlete = makeAthlete({ total_sessions_logged: 120 });
  const rows = yearOfLogs(athlete.id);
  await mockApi(page, { athlete, dataReads: { workouts: rows.slice(-40), athlete_stats: statsRowFor(athlete, rows), prs: [], manual_one_rms: [] } });
  await loginAsAthlete(page, athlete);
  await page.getByRole("button", { name: "PROGRESS" }).click();
  await page.getByRole("button", { name: /^strength$/i }).click();
  const ctl = page.getByRole("tablist", { name: "Time range" });
  await expect(ctl).toBeVisible({ timeout: 15000 });
  await expect(ctl.getByRole("tab", { name: "3M" })).toHaveAttribute("aria-selected", "true");
  await expect(ctl.getByRole("tab")).toHaveCount(4);
  await expect(page.getByText(/\d+ days logged/).first()).toBeVisible();
  await shot(page, "progress-strength-3m");
  await ctl.getByRole("tab", { name: "1Y" }).click();
  await expect(page.getByText(/\d+ weeks? · weekly best/).first()).toBeVisible();
  await shot(page, "progress-strength-1y");
  await ctl.getByRole("tab", { name: "1W" }).click();
  await expect(page.getByText(/\d+ days? logged/).first()).toBeVisible();
  // Running tab carries the same control; 1Y charts miles per week.
  await page.getByRole("button", { name: /^running$/i }).click();
  await expect(page.getByRole("tablist", { name: "Time range" })).toBeVisible();
  await page.getByRole("tablist", { name: "Time range" }).getByRole("tab", { name: "1Y" }).click();
  await expect(page.getByText("Miles per week")).toBeVisible();
  await shot(page, "progress-running-1y");
});

// The Proof block: a SECTION of the edition (label + body like every other
// section, plus the figures), drawn as a grid after the rank hero.
const digestWith = (athlete, type, sections) => ({
  id: `d-${type}`, athlete_id: athlete.id, digest_type: type, is_read: false,
  generated_at: new Date().toISOString(), created_at: new Date().toISOString(),
  label: type === "monthly" ? "MONTHLY RECAP: September 2026" : "WEEKLY EDITION",
  content_json: {
    intro: type === "monthly" ? "Test, let's zoom out on the month." : "Test, week 14 is in the books.",
    sections,
    questions: [{ id: "recovery", kind: "context", deeper: false, text: "Recovery: dialed, flat, or running on fumes?" }],
    flags: {},
  },
});
const baseSections = [
  { label: "GRIT RANK", body: "STRONG. Strength Score 770, up 50." },
  { label: "WEEK VS WEEK", body: "More weight moved on fewer sessions." },
  { label: "FOCUS NEXT WEEK", body: "Keep the bench climbing." },
];

for (const type of ["weekly", "monthly"]) {
  test(`Proof ${type} edition: BY THE NUMBERS section renders as the grid after the rank hero`, async ({ page }) => {
    const athlete = makeAthlete({ total_sessions_logged: 120 });
    const rows = yearOfLogs(athlete.id);
    const stats = statsRowFor(athlete, rows)[0].stats;
    const nums = type === "monthly" ? monthNumbers(stats) : weekNumbers(stats);
    expect(nums).not.toBeNull();
    const sec = numbersSection(nums, { unit: "lbs", period: type === "monthly" ? "month" : "week" });
    const digest = digestWith(athlete, type, withNumbersSection({ sections: baseSections }, sec).sections);
    expect(digest.content_json.sections[1].label).toBe(sec.label);
    await mockApi(page, { athlete, dataReads: { workouts: rows.slice(-40), proof_digests: [digest], athlete_stats: statsRowFor(athlete, rows), prs: [], manual_one_rms: [] } });
    await loginAsAthlete(page, athlete);
    await page.getByRole("button", { name: "MY LOG" }).click();
    await page.getByRole("button", { name: /^proof$/i }).click();
    await expect(page.getByText(/OPEN THIS (WEEK|MONTH)'S EDITION/)).toBeVisible({ timeout: 15000 });
    await page.getByText(/OPEN THIS (WEEK|MONTH)'S EDITION/).click();
    await expect(page.getByText(type === "monthly" ? "By the numbers · this month" : "By the numbers · this week")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(fmt(nums.tonnage), { exact: true })).toBeVisible();
    await expect(page.getByText("Sessions logged", { exact: true })).toBeVisible();
    await expect(page.getByText("Most sets", { exact: true })).toBeVisible();
    await expect(page.getByText(new RegExp(`vs last ${type === "monthly" ? "month" : "week"}`)).first()).toBeVisible();
    // The grid replaces the section's text body; the body never prints twice.
    await expect(page.getByText(sec.body, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /share/i })).toHaveCount(0);
    await shot(page, `proof-${type}-numbers`);
  });
}
