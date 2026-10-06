import type { Part } from "./types";

export type PartRun = { kind: "single"; part: Part } | { kind: "tools"; parts: Part[] };

interface ToolCategory {
  tools: string[];
  describe: (count: number) => string;
}

const plural = (count: number, singular: string, pluralForm = `${singular}s`): string => `${count} ${count === 1 ? singular : pluralForm}`;

const TOOL_CATEGORIES: ToolCategory[] = [
  { tools: ["read"], describe: (count) => `read ${plural(count, "file")}` },
  { tools: ["grep", "glob", "list", "ls", "websearch"], describe: (count) => (count === 1 ? "searched" : `searched ${count} times`) },
  { tools: ["edit", "multiedit", "write", "notebookedit", "patch"], describe: (count) => `edited ${plural(count, "file")}` },
  { tools: ["bash", "shell"], describe: (count) => (count === 1 ? "ran a command" : `ran ${count} commands`) },
  { tools: ["webfetch"], describe: (count) => `fetched ${plural(count, "page")}` },
  { tools: ["task", "agent"], describe: (count) => (count === 1 ? "used a subagent" : `used ${count} subagents`) },
];

const toolNameOf = (part: Part): string => String(part.meta?.tool ?? "").toLowerCase();

const categoryOf = (part: Part): ToolCategory | undefined => TOOL_CATEGORIES.find((category) => category.tools.includes(toolNameOf(part)));

export const groupToolRuns = (parts: Part[]): PartRun[] =>
  parts.reduce<PartRun[]>((runs, part) => {
    const last = runs[runs.length - 1];
    if (part.type !== "tool") return [...runs, { kind: "single", part }];
    if (last?.kind === "tools") return [...runs.slice(0, -1), { kind: "tools", parts: [...last.parts, part] }];
    return [...runs, { kind: "tools", parts: [part] }];
  }, []);

export const describeToolGroup = (parts: Part[]): string => {
  const phrases: string[] = [];
  const otherNames: string[] = [];
  TOOL_CATEGORIES.forEach((category) => {
    const count = parts.filter((part) => categoryOf(part) === category).length;
    if (count > 0) phrases.push(category.describe(count));
  });
  parts.filter((part) => !categoryOf(part)).forEach((part) => {
    const name = String(part.meta?.tool ?? "a tool");
    if (!otherNames.includes(name)) otherNames.push(name);
  });
  if (otherNames.length > 0) phrases.push(`used ${otherNames.join(", ")}`);
  const sentence = phrases.join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
};

export const toolGroupStatus = (parts: Part[]): string => {
  const statuses = parts.map((part) => String(part.meta?.status));
  if (statuses.some((status) => status === "error")) return "error";
  if (statuses.some((status) => status === "running" || status === "pending")) return "running";
  return "done";
};
