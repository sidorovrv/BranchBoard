import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as base, type Page } from "@playwright/test";
import { startServer } from "../../packages/server/src/start";

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

export interface Instance {
  port: number;
  baseUrl: string;
  accessLink: string;
  dataDirectory: string;
}

export interface DemoBoard {
  projectId: string;
  boardId: string;
}

export const test = base.extend<{ instance: Instance; demo: DemoBoard; appPage: Page }>({
  instance: async ({}, use) => {
    process.env.BRANCHBOARD_OFFLINE = "1";
    const dataDirectory = mkdtempSync(join(tmpdir(), "branchboard-e2e-"));
    const port = await freePort();
    const { accessLink, stop } = await startServer({ port, dataDirectory, webRoot: join(import.meta.dirname, "..", "..", "packages", "web", "dist") });
    await use({ port, baseUrl: `http://127.0.0.1:${port}`, accessLink, dataDirectory });
    await stop();
    rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  },
  demo: async ({ instance, page }, use) => {
    await page.goto(instance.accessLink);
    const send = async (command: Record<string, unknown>) => {
      const response = await page.request.post(`${instance.baseUrl}/api/commands`, { data: command, headers: { origin: instance.baseUrl } });
      expect(response.ok()).toBe(true);
      return response.json();
    };
    const project = await send({ type: "createProject", workspacePath: instance.dataDirectory, mode: "fake", name: "Demo" });
    const board = await send({ type: "createBoard", projectId: project.id, title: "Demo board" });
    await use({ projectId: project.id, boardId: board.id });
  },
  appPage: async ({ page, instance, demo }, use) => {
    await page.goto(`${instance.baseUrl}/?demo`);
    await use(page);
  },
});

export { expect, type Page };
