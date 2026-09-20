// ─── T62: iOS keyboard geometry (useKeyboardInset) ────────────────────────────
// On iOS the keyboard never shrinks the layout viewport — the OS pans the page,
// which wedged the chat + Memory-tab composers mid-screen and left grey dead
// bands after dismissal (Will's 08-31 screenshots). The fix pads the 100dvh
// shell / Program modal by the keyboard inset and clamps the document to 0
// while an input is focused. A desktop browser has no real keyboard inset, so
// these specs drive the same signals the hook listens to: shrink
// window.innerHeight (the layout viewport reading) and fire a visualViewport
// resize with an editable focused. What they pin down is the CONTRACT:
//   • focused + shrunk viewport → the shell pads its bottom by the difference
//   • dismissal (viewport restored) → padding fully retired, no leftover gap
//   • while engaged, a panned document snaps back to 0
import { test, expect } from "@playwright/test";
import { mockApi, makeAthlete, loginAsAthlete } from "./mocks.js";

const KB = 320; // fake keyboard height, px

// The 100dvh shell is the composer's flex root: the element whose paddingBottom
// the hook drives. Reached from the composer textarea so the selector tracks
// the real structure instead of a class name.
const shellPad = (page) => page.evaluate(() => {
  const ta = document.querySelector('[data-tour="chat-input"]');
  return ta ? parseInt(getComputedStyle(ta.parentElement).paddingBottom || "0", 10) : null;
});

const fakeKeyboard = async (page, show) => {
  await page.evaluate((args) => {
    const { show, KB } = args;
    if (show) {
      if (!window.__realInnerHeight) window.__realInnerHeight = window.innerHeight;
      Object.defineProperty(window, "innerHeight", { configurable: true, get: () => window.__realInnerHeight + KB });
    } else if (window.__realInnerHeight) {
      Object.defineProperty(window, "innerHeight", { configurable: true, get: () => window.__realInnerHeight });
    }
    window.visualViewport.dispatchEvent(new Event("resize"));
  }, { show, KB });
};

test("keyboard inset pads the shell while the composer is focused and retires on dismiss", async ({ page }) => {
  const athlete = makeAthlete({});
  await mockApi(page, { athlete });
  await loginAsAthlete(page, athlete);

  const composer = page.locator("textarea").last();
  await composer.click();
  await fakeKeyboard(page, true);
  await expect.poll(() => shellPad(page)).toBe(KB);

  // Dismissal: blur + viewport restored → no phantom padding survives.
  await composer.blur();
  await fakeKeyboard(page, false);
  await expect.poll(() => shellPad(page)).toBe(0);
});

test("while the keyboard owns layout, a panned document snaps back to 0", async ({ page }) => {
  const athlete = makeAthlete({});
  await mockApi(page, { athlete });
  await loginAsAthlete(page, athlete);

  await page.locator("textarea").last().click();
  await fakeKeyboard(page, true);
  await expect.poll(() => shellPad(page)).toBe(KB);

  // The OS pan: scroll the document while engaged, then let the hook see a
  // viewport event — the clamp must put it back.
  await page.evaluate(() => {
    document.documentElement.style.height = "200vh"; // give the doc room to pan
    window.scrollTo(0, 120);
    window.visualViewport.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

// ─── 09-20: the focused field stays in view ───────────────────────────────────
// The document clamp cancels iOS's own reveal-the-input pan, and padding the
// shell shrinks every inner scroller from the bottom — so a field anywhere but
// the very bottom ended up under the fold with the list parked at its top
// ("I tap to type and it flies away", Will's phone). revealCaret() owes that
// reveal back. Driven on the geometry harness (tests/harness/kb.html): the same
// shell / log-sheet / full-screen-modal skeleton, mounted on the REAL hook.
const caretVisible = (page, sel) => page.evaluate((sel) => {
  const el = document.querySelector(sel), sc = el.closest("[data-sc]");
  const box = sc.getBoundingClientRect(), r = el.getBoundingClientRect();
  return { scrollTop: Math.round(sc.scrollTop), boxTop: box.top, boxBottom: box.bottom, top: r.top, bottom: r.bottom };
}, sel);

test("a lower form field is scrolled back above the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto("/tests/harness/kb.html#modal");
  const field = page.locator("#f8");
  await field.click();
  await fakeKeyboard(page, true);
  await expect.poll(async () => { const g = await caretVisible(page, "#f8"); return g.bottom <= g.boxBottom && g.top >= g.boxTop; }).toBe(true);
  expect((await caretVisible(page, "#f8")).scrollTop).toBeGreaterThan(0);
});

test("a caret deep in the log sheet stays in view; a caret already in view is left alone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto("/tests/harness/kb.html#sheet");
  const ta = page.locator("#sheetta");
  // Caret on line 1: already visible once the keyboard is up → nothing moves.
  await ta.click({ position: { x: 40, y: 20 } });
  await fakeKeyboard(page, true);
  await page.waitForTimeout(300);
  expect((await caretVisible(page, "#sheetta")).scrollTop).toBe(0);
  // Move the caret to line 10 (selectionchange path): the sheet scrolls to it.
  await page.evaluate(() => { const t = document.querySelector("#sheetta"); const at = t.value.indexOf("Line 10"); t.setSelectionRange(at, at); });
  await expect.poll(async () => (await caretVisible(page, "#sheetta")).scrollTop).toBeGreaterThan(0);
});
