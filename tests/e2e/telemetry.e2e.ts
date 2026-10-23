import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Instance } from "./fixtures";

const SWITCH = "Send aggregated anonymous telemetry";
const DECLINE = "Do not share";
const ACCEPT = "Share usage statistics";

const storedConsent = (instance: Instance) => JSON.parse(readFileSync(join(instance.dataDirectory, "telemetry.json"), "utf8")).consent;

test.beforeEach(async ({ appPage, instance, demo }) => {
  writeFileSync(join(instance.dataDirectory, "telemetry.json"), JSON.stringify({ schema: 1, successfulRuns: 24, firstDay: "2026-10-01" }));
  await appPage.locator(".sidebar-board-open", { hasText: "Demo board" }).click();
  await expect(appPage.locator(".react-flow")).toBeVisible();
  const response = await appPage.request.post(`${instance.baseUrl}/api/commands`, { data: { type: "reply", boardId: demo.boardId, prompt: "hello", run: true }, headers: { origin: instance.baseUrl } });
  expect(response.ok()).toBe(true);
  await expect(appPage.locator(".telemetry-dialog")).toBeVisible({ timeout: 15000 });
});

test("the dialog shows the counts and stays open on Escape", async ({ appPage }) => {
  await expect(appPage.locator(".telemetry-dialog")).toContainText("Runs today");
  await expect(appPage.locator(".telemetry-dialog")).toContainText("Share these usage statistics?");
  await appPage.keyboard.press("Escape");
  await expect(appPage.locator(".telemetry-dialog")).toBeVisible();
  await expect(appPage.locator(".telemetry-actions button.primary")).toHaveCount(0);
});

test("the dialog shows the opt-in status and closes with the close button", async ({ appPage }) => {
  await expect(appPage.locator(".telemetry-header .key-status")).toHaveText("No choice made yet");
  await appPage.locator(".telemetry-header").getByRole("button", { name: "Close" }).click();
  await expect(appPage.locator(".telemetry-dialog")).toBeHidden();
});

test("declining closes the dialog, stores the choice and does not ask again", async ({ appPage, instance }) => {
  await appPage.getByRole("button", { name: DECLINE }).click();
  await expect(appPage.locator(".telemetry-dialog")).toBeHidden();
  await expect.poll(() => storedConsent(instance)).toBe("declined");
  await appPage.reload();
  await expect(appPage.locator(".react-flow")).toBeVisible();
  await expect(appPage.locator(".telemetry-dialog")).toBeHidden();
});

test("accepting stores the choice and the Settings switch changes it", async ({ appPage, instance }) => {
  await appPage.getByRole("button", { name: ACCEPT }).click();
  await expect(appPage.locator(".telemetry-dialog")).toBeHidden();
  await expect.poll(() => storedConsent(instance)).toBe("granted");
  await appPage.getByRole("button", { name: "Settings" }).click();
  await appPage.locator(".settings-pinned").click();
  const toggle = appPage.getByRole("switch", { name: SWITCH });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect.poll(() => storedConsent(instance)).toBe("declined");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await appPage.getByRole("button", { name: "Show", exact: true }).click();
  await expect(appPage.locator(".telemetry-preview")).toContainText("Runs today");
});
