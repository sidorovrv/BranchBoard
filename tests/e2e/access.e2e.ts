import { expect, test } from "./fixtures";

test("the app is locked without the access key and opens with it", async ({ instance, page }) => {
  const locked = await page.request.get(instance.baseUrl);
  expect(locked.status()).toBe(401);
  await page.goto(instance.accessLink);
  await expect(page).toHaveURL(`${instance.baseUrl}/`);
  const unlocked = await page.request.get(instance.baseUrl);
  expect(unlocked.status()).toBe(200);
});
