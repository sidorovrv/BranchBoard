import { join } from "node:path";
import { expect, test } from "./fixtures";

const SECRET = "sk-test-NEVERSHOWNTHISKEY0123456789";

test.beforeEach(async ({ appPage }) => {
  await appPage.locator(".sidebar-board-open", { hasText: "Demo board" }).click();
  await expect(appPage.locator(".react-flow")).toBeVisible();
  appPage.on("dialog", (dialog) => void dialog.accept());
});

test("an API key is saved without being shown again, and can be replaced or removed", async ({ appPage }) => {
  await appPage.getByRole("button", { name: "Settings", exact: true }).click();
  await appPage.getByRole("button", { name: "Models" }).click();
  const card = appPage.locator(".key-entry", { hasText: "OpenAI-compatible" });
  await card.getByLabel("Address").fill("http://127.0.0.1:9/v1");
  await card.getByLabel(/API key/).fill(SECRET);
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card).toContainText("Key saved on");
  await expect(card.locator("input[type=password]")).toHaveCount(0);
  expect(await appPage.content()).not.toContain(SECRET);
  await card.getByRole("button", { name: "Replace" }).click();
  await expect(card.locator("input[type=password]")).toHaveValue("");
  await card.getByRole("button", { name: "Cancel" }).click();
  await card.getByRole("button", { name: "Remove" }).click();
  await expect(card).not.toContainText("Key saved on");
});

test("connecting a project with a missing claude command shows the install steps", async ({ appPage, instance }) => {
  process.env.BRANCHBOARD_CLAUDE_PATH = join(instance.dataDirectory, "no-such-claude");
  await appPage.getByRole("button", { name: "Connect a project folder" }).click();
  const dialog = appPage.locator(".dialog", { hasText: "Connect a project" });
  await expect(dialog.locator(".setup-guide")).toContainText("npm install -g @anthropic-ai/claude-code");
  await expect(dialog.getByRole("button", { name: "Connect" })).toBeDisabled();
  delete process.env.BRANCHBOARD_CLAUDE_PATH;
});
