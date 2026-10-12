import { expect, test } from "./fixtures";

test("the app is locked without the access key and opens with it", async ({ instance, page }) => {
  const locked = await page.request.get(instance.baseUrl);
  expect(locked.status()).toBe(401);
  await page.goto(instance.accessLink);
  await expect(page).toHaveURL(`${instance.baseUrl}/`);
  const unlocked = await page.request.get(instance.baseUrl);
  expect(unlocked.status()).toBe(200);
});

test("a board created through a command shows in the sidebar and opens", async ({ appPage }) => {
  await expect(appPage.locator(".sidebar")).toContainText("Demo");
  await appPage.locator(".sidebar-board-open", { hasText: "Demo board" }).click();
  await expect(appPage.locator(".react-flow")).toBeVisible();
});
