import { expect, test } from "./fixtures";

test.beforeEach(async ({ appPage }) => {
  await appPage.locator(".sidebar-board-open", { hasText: "Demo board" }).click();
  await expect(appPage.locator(".react-flow")).toBeVisible();
});

test("the settings dialog opens and closes", async ({ appPage }) => {
  await appPage.getByRole("button", { name: "Settings" }).click();
  await expect(appPage.locator(".settings-dialog")).toBeVisible();
  await appPage.keyboard.press("Escape");
  await expect(appPage.locator(".settings-dialog")).toBeHidden();
});

test("the trash dialog states how long items are kept", async ({ appPage }) => {
  await appPage.getByRole("button", { name: "Trash", exact: true }).click();
  await expect(appPage.locator(".trash-dialog")).toContainText("30 days");
});

test("a finished answer with a table is drawn as a sortable data table", async ({ appPage, instance, demo }) => {
  const prompt = "| name | count |\n|---|---|\n| pear | 3 |\n| fig | 1 |";
  const response = await appPage.request.post(`${instance.baseUrl}/api/commands`, {
    data: { type: "reply", boardId: demo.boardId, prompt, run: true },
    headers: { origin: instance.baseUrl },
  });
  expect(response.ok()).toBe(true);
  await expect(appPage.locator(".data-table")).toBeVisible({ timeout: 15000 });
  await expect(appPage.locator(".data-table")).toContainText("pear");
});
