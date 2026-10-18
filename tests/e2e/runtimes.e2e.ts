import type { Locator, Page, Route } from "@playwright/test";
import type { Catalog } from "@branchboard/core";
import { fakeCodexPath } from "./fakeCodex";
import { expect, test, type Instance } from "./fixtures";

const BOARD_CATALOG = /\/api\/runtime\/catalog\?board=/;
const MODE_CATALOG = /\/api\/runtime\/catalog\?mode=/;

const EMPTY_CATALOG: Catalog = { agents: [], models: [], health: { ok: true, detail: "ready" } };

const withCatalog =(page: Page, pattern: RegExp, change: (catalog: Catalog) => Partial<Catalog>) =>
  page.route(pattern, async (route: Route) => {
    const response = await route.fetch();
    const catalog = (await response.json()) as Catalog;
    await route.fulfill({ response, json: { ...catalog, ...change(catalog) } });
  });

const clickWithoutScrolling = async (button: Locator) => {
  await expect(button).toBeEnabled();
  await button.dispatchEvent("click");
};

const openDemoBoard = async (page: Page) => {
  await page.locator(".sidebar-board-open", { hasText: "Demo board" }).click();
  await expect(page.locator(".react-flow")).toBeVisible();
};

const openProjectDialog = async (page: Page) => {
  await page.getByRole("button", { name: "Connect a project folder" }).click();
  return page.locator(".dialog", { hasText: "Connect a project" });
};

const chooseRuntime = async (page: Page, dialog: Locator, label: RegExp) => {
  await dialog.getByRole("button", { name: "Runtime" }).click();
  await page.getByRole("option", { name: label }).click();
};

const send = (page: Page, instance: Instance) => async (command: Record<string, unknown>) => {
  const response = await page.request.post(`${instance.baseUrl}/api/commands`, { data: command, headers: { origin: instance.baseUrl } });
  expect(response.ok()).toBe(true);
  return response.json();
};

test("the permission mode chip sets the mode of the run", async ({ appPage, instance, demo }) => {
  await openDemoBoard(appPage);
  await send(appPage, instance)({ type: "reply", boardId: demo.boardId, prompt: "" });
  const chip = appPage.locator(".chip-select[aria-label^='Permission mode']");
  await expect(chip).toBeVisible();
  await chip.click();
  await appPage.getByRole("option", { name: "Plan" }).click();
  await expect(chip).toContainText("Plan");
});

test("the top bar shows the meters the catalog lists", async ({ appPage }) => {
  await withCatalog(appPage, BOARD_CATALOG, () => ({ meters: ["cost"] }));
  await openDemoBoard(appPage);
  await expect(appPage.locator(".limits .cost-value")).toBeVisible();
});

test("a running node offers a follow-up and a background button when the catalog lists the controls", async ({ appPage, instance, demo }) => {
  await withCatalog(appPage, BOARD_CATALOG, () => ({ controls: ["followUp", "background"] }));
  const controlCommands: Record<string, unknown>[] = [];
  await appPage.route(/\/api\/commands$/, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.type !== "controlRun") return route.continue();
    controlCommands.push(body);
    return route.fulfill({ json: {} });
  });
  await openDemoBoard(appPage);
  await send(appPage, instance)({ type: "reply", boardId: demo.boardId, prompt: "/slow keep running", run: true });
  const live = appPage.locator(".live-controls");
  await expect(live).toBeVisible();
  await live.getByLabel("Follow-up message").fill("also check the tests");
  await clickWithoutScrolling(live.getByRole("button", { name: "Send" }));
  await clickWithoutScrolling(live.getByRole("button", { name: "Move to background" }));
  await expect.poll(() => controlCommands.map((command) => command.control)).toEqual(["followUp", "background"]);
  expect(controlCommands[0].text).toBe("also check the tests");
});

test("a form asks typed fields, hides a conditional field until its condition holds and answers once", async ({ appPage, instance, demo }) => {
  await openDemoBoard(appPage);
  const nodeId = (await send(appPage, instance)({ type: "reply", boardId: demo.boardId, prompt: "/form", run: true })).nodeId as string;
  const request = appPage.locator(".request-card");
  await expect(request).toBeVisible({ timeout: 15000 });
  await expect(request.locator(".question-field")).toHaveCount(4);
  await expect(request.getByPlaceholder("Type a number")).toBeVisible();
  await expect(request.getByRole("link", { name: "https://example.com/terms" })).toHaveAttribute("href", "https://example.com/terms");
  const answer = request.getByRole("button", { name: "Answer" });
  await expect(answer).toBeDisabled();
  await request.locator(".question-field").nth(0).getByPlaceholder("Type your answer").fill("Ada");
  await request.getByPlaceholder("Type a number").fill("3");
  await request.locator(".question-field").nth(2).getByRole("button", { name: "Yes" }).click();
  await expect(request.locator(".question-field")).toHaveCount(5);
  await request.locator(".question-field").nth(3).getByPlaceholder("Type your answer").fill("1 Main St");
  await expect(answer).toBeDisabled();
  await request.locator(".question-field").last().getByRole("button", { name: "Done" }).click();
  await expect(answer).toBeEnabled();
  await request.locator(".question-field").nth(2).getByRole("button", { name: "No" }).click();
  await expect(request.locator(".question-field")).toHaveCount(4);
  await answer.click();
  await expect.poll(async () => (await (await appPage.request.get(`${instance.baseUrl}/api/boards/${demo.boardId}/graph`)).json()).graph.nodes[nodeId].status).toBe("done");
  const view = await (await appPage.request.get(`${instance.baseUrl}/api/boards/${demo.boardId}/graph`)).json();
  const tool = view.parts[nodeId].find((part: { type: string }) => part.type === "tool");
  expect(JSON.parse(tool.meta.output)).toEqual([["Ada"], ["3"], ["No"], [], ["Done"]]);
});

test("a Codex project runs a turn, asks for a command on the board and shows the plan limits", async ({ appPage, instance }) => {
  process.env.BRANCHBOARD_CODEX_PATH = fakeCodexPath();
  const command = send(appPage, instance);
  const project = await command({ type: "createProject", workspacePath: instance.dataDirectory, mode: "codex", name: "Codex" });
  const board = await command({ type: "createBoard", projectId: project.id, title: "Codex board" });
  await appPage.reload();
  await appPage.locator(".sidebar-board-open", { hasText: "Codex board" }).click();
  await expect(appPage.locator(".react-flow")).toBeVisible();
  const nodeId = (await command({ type: "reply", boardId: board.id, prompt: "approve the test run", run: true })).nodeId as string;
  const request = appPage.locator(".request-card");
  await expect(request).toContainText("Allow command?", { timeout: 15000 });
  await expect(request).toContainText("npm test");
  await request.getByRole("button", { name: "Allow once" }).click();
  await expect(appPage.locator(`.react-flow__node[data-id="${nodeId}"] .answer`)).toContainText("Ran npm test", { timeout: 15000 });
  await expect(appPage.locator(".limits .limit-value").first()).toHaveText("20%");
});

test("the project dialog offers the ChatGPT subscription with its terms", async ({ appPage }) => {
  await openDemoBoard(appPage);
  await appPage.route(MODE_CATALOG, (route) => route.fulfill({ json: EMPTY_CATALOG }));
  const dialog = await openProjectDialog(appPage);
  await chooseRuntime(appPage, dialog, /ChatGPT subscription/);
  await expect(dialog).toContainText("Uses the installed codex command and its codex login");
  await expect(dialog.getByRole("link", { name: "Codex app-server terms" })).toHaveAttribute("href", "https://learn.chatgpt.com/docs/app-server");
});

test("the project dialog lists the API runtimes with the trust note and the engine notice", async ({ appPage }) => {
  await openDemoBoard(appPage);
  await appPage.route(MODE_CATALOG, (route) => route.fulfill({ json: { ...EMPTY_CATALOG, engine: { phase: "idle", version: "2.0.27" } } }));
  const dialog = await openProjectDialog(appPage);
  await dialog.getByRole("button", { name: "Runtime" }).click();
  const labels = await appPage.getByRole("option").allTextContents();
  expect(labels).toEqual(expect.arrayContaining([expect.stringContaining("Anthropic API"), expect.stringContaining("OpenAI-compatible API")]));
  await appPage.getByRole("option", { name: /Anthropic API/ }).click();
  await expect(dialog).toContainText("read and edit files and run commands in this folder");
  await expect(dialog).toContainText("downloads the OpenCode engine v2.0.27");
});

test("the engine download shows its progress and a retry button after a failure", async ({ appPage }) => {
  await openDemoBoard(appPage);
  let phase: "installing" | "failed" = "installing";
  await appPage.route(MODE_CATALOG, (route) => {
    const message = phase === "installing" ? "Downloading the engine." : "No network connection.";
    return route.fulfill({ json: { ...EMPTY_CATALOG, engine: { phase, version: "2.0.27", message } } });
  });
  const dialog = await openProjectDialog(appPage);
  await chooseRuntime(appPage, dialog, /OpenAI-compatible API/);
  await expect(dialog).toContainText("Downloading the engine.");
  phase = "failed";
  await expect(dialog.getByRole("button", { name: "Try again" })).toBeVisible({ timeout: 15000 });
  await expect(dialog).toContainText("No network connection.");
});

test("the Models tab does not start the engine and keeps the OpenCode server password out of the page", async ({ appPage, instance }) => {
  const catalogReads: string[] = [];
  appPage.on("request", (request) => request.url().includes("/api/runtime/catalog") && catalogReads.push(request.url()));
  await openDemoBoard(appPage);
  await appPage.getByRole("button", { name: "Settings", exact: true }).click();
  await appPage.getByRole("button", { name: "Models" }).click();
  const card = appPage.locator(".key-entry", { hasText: "OpenCode server" });
  await expect(card).toBeVisible();
  expect(catalogReads.filter((url) => url.includes("mode=opencode"))).toEqual([]);
  await card.getByLabel("Server address").fill("http://127.0.0.1:9");
  await card.getByLabel("Server password").fill("service-password-value");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByLabel("Server address")).toHaveValue("http://127.0.0.1:9");
  await expect(card.getByLabel("Server password")).toHaveAttribute("placeholder", "Saved. Type to replace it");
  expect(await appPage.content()).not.toContain("service-password-value");
  await card.getByRole("button", { name: "Check connection" }).click();
  await expect(card.locator(".part-error")).toContainText("did not answer");
  await card.getByRole("button", { name: "Disconnect" }).click();
  await expect(card.getByLabel("Server address")).toHaveValue("");
  void instance;
});
