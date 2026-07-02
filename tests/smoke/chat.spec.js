// Smoke: chat round-trip — a plain question goes out through the mocked Claude
// proxy and the coach's answer renders as an assistant bubble.
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete, emptyParse } from "./mocks.js";

test("a chat message round-trips through the AI proxy", async ({ page }) => {
  const athlete = makeAthlete();
  const reply = "Aim for about a gram of protein per pound of bodyweight.";
  // emptyParse = no exercises extracted -> pure chat, no workout persistence.
  const { calls } = await mockApi(page, { athlete, parseResult: emptyParse, chatReply: reply });

  await loginAsAthlete(page, athlete);
  await expect(page.getByText(/Tell me about your first workout/)).toBeVisible();

  const question = "How much protein should I eat every day?";
  await page.getByPlaceholder(/Tell Coach Joe about your workout/).fill(question);
  await page.getByRole("button", { name: "→", exact: true }).click();

  await expect(page.getByText(question)).toBeVisible();  // user bubble
  await expect(page.getByText(reply)).toBeVisible();     // assistant bubble

  // The proxy really was called with the question (coaching call, not just the parser).
  await expect
    .poll(() => calls.some((c) => {
      if (!c.url.endsWith("/api/claude") || c.body?.feature === "workout_parse") return false;
      const content = c.body?.messages?.[0]?.content;
      return Array.isArray(content) && content.some((p) => p.type === "text" && p.text.includes(question));
    }))
    .toBe(true);

  // Input is ready for the next message (loading state cleared).
  await expect(page.getByPlaceholder(/Tell Coach Joe about your workout/)).toBeEnabled();
});
