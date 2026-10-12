import { SAMPLE_BOARD_TITLE, TOUR_STEPS } from "@branchboard/core";
import { expect, test } from "./fixtures";

test.beforeEach(async ({ appPage }) => {
  await appPage.locator(".sidebar-board-open", { hasText: "Demo board" }).click();
  await expect(appPage.locator(".react-flow")).toBeVisible();
});

const openHelpEntry = async (page: import("@playwright/test").Page, name: string) => {
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await page.locator(".context-menu").getByRole("button", { name }).click();
};

test("the Help menu has no sample board entry and the sample board is not listed anywhere", async ({ appPage }) => {
  await appPage.getByRole("button", { name: "Help", exact: true }).click();
  await expect(appPage.locator(".context-menu").getByRole("button", { name: /sample/i })).toHaveCount(0);
  await appPage.keyboard.press("Escape");
  await expect(appPage.locator(".sidebar", { hasText: SAMPLE_BOARD_TITLE })).toHaveCount(0);
});

test("the tour reaches every anchor, ends with Finish and returns to the previous board", async ({ appPage }) => {
  await openHelpEntry(appPage, "Take the tour");
  const card = appPage.locator(".tour-card");
  for (const [index, step] of TOUR_STEPS.entries()) {
    await expect(card).toContainText(step.title);
    await expect(appPage.locator(".tour-spotlight"), `anchor ${step.anchor} is missing`).toBeVisible();
    if (index < TOUR_STEPS.length - 1) await card.getByRole("button", { name: "Next" }).click();
  }
  await expect(card.getByRole("button", { name: "Next" })).toHaveCount(0);
  await card.getByRole("button", { name: "Finish" }).click();
  await expect(card).toHaveCount(0);
  await expect(appPage.locator(".board-crumb, .sidebar-board-open.active", { hasText: "Demo board" }).first()).toBeVisible();
  await expect(appPage.locator("[data-node-title]", { hasText: SAMPLE_BOARD_TITLE })).toHaveCount(0);
});

test("the sample board cannot be edited during the tour", async ({ appPage }) => {
  await openHelpEntry(appPage, "Take the tour");
  await expect(appPage.locator(".tour-card")).toBeVisible();
  const before = await appPage.locator(".react-flow__node").count();
  await appPage.keyboard.press("Alt+N");
  await expect(appPage.locator(".react-flow__node")).toHaveCount(before);
  await appPage.locator(".tour-card").getByRole("button", { name: "Skip" }).click();
  await expect(appPage.locator(".tour-card")).toHaveCount(0);
});

test("Shift+? opens the shortcuts guide with the bound and fixed shortcuts", async ({ appPage }) => {
  await appPage.locator(".react-flow").click({ position: { x: 5, y: 5 } });
  await appPage.keyboard.press("Shift+?");
  const dialog = appPage.getByRole("dialog", { name: "Shortcuts" });
  await expect(dialog).toContainText("Undo");
  await expect(dialog).toContainText("Show the shortcuts");
  await expect(dialog).toContainText("box-select nodes");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
});
