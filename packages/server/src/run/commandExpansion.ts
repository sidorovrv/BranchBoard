import { exec } from "node:child_process";
import { fillTemplate, slashCommandOf, type CatalogCommand } from "@branchboard/core";

const SHELL_INJECTION_PATTERN = /!`([^`]+)`/g;
const SHELL_TIMEOUT_MS = 30000;
const SHELL_OUTPUT_LIMIT = 200000;

export type ShellRunner = (command: string, workspacePath: string) => Promise<string>;

export const runShellInjection: ShellRunner = (command, workspacePath) =>
  new Promise((resolve) => {
    exec(command, { cwd: workspacePath, timeout: SHELL_TIMEOUT_MS, maxBuffer: SHELL_OUTPUT_LIMIT, windowsHide: true }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      resolve(error && !output ? `[command failed: ${error.message}]` : output);
    });
  });

export const expandShellInjections = async (text: string, workspacePath: string, run: ShellRunner = runShellInjection): Promise<string> => {
  const matches = [...text.matchAll(SHELL_INJECTION_PATTERN)];
  const outputs = await Promise.all(matches.map((match) => run(match[1], workspacePath)));
  let index = 0;
  return text.replace(SHELL_INJECTION_PATTERN, () => outputs[index++]);
};

export const expandCommandTemplate = async (prompt: string, command: CatalogCommand, workspacePath: string, run?: ShellRunner): Promise<string> =>
  fillTemplate(await expandShellInjections(command.template, workspacePath, run), slashCommandOf(prompt)?.argumentsText ?? "");
