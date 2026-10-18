import type { ChatPart } from "./types";

export type PartRun<Part extends ChatPart = ChatPart> = { kind: "single"; part: Part } | { kind: "tools"; parts: Part[] };

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

const toolNameOf = (part: ChatPart): string => String(part.meta?.tool ?? "").toLowerCase();

const categoryOf = (part: ChatPart): ToolCategory | undefined => TOOL_CATEGORIES.find((category) => category.tools.includes(toolNameOf(part)));

const stretchesOf = <Part extends ChatPart>(parts: Part[]): Part[][] =>
  parts.reduce<Part[][]>((stretches, part) => {
    const last = stretches[stretches.length - 1];
    if (!last || part.type === "text" || last[0]?.type === "text") return [...stretches, [part]];
    return [...stretches.slice(0, -1), [...last, part]];
  }, []);

const runsOfStretch = <Part extends ChatPart>(stretch: Part[]): PartRun<Part>[] => {
  const firstToolIndex = stretch.findIndex((part) => part.type === "tool");
  const toSingle = (part: Part): PartRun<Part> => ({ kind: "single", part });
  if (firstToolIndex < 0) return stretch.map(toSingle);
  const others = stretch.filter((part) => part.type !== "tool").map(toSingle);
  return [...others.slice(0, firstToolIndex), { kind: "tools", parts: stretch.filter((part) => part.type === "tool") }, ...others.slice(firstToolIndex)];
};

export const groupToolRuns = <Part extends ChatPart>(parts: Part[]): PartRun<Part>[] => stretchesOf(parts).flatMap(runsOfStretch);

export const describeToolGroup = (parts: ChatPart[]): string => {
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

export const toolGroupStatus = (parts: ChatPart[]): string => {
  const statuses = parts.map((part) => String(part.meta?.status));
  if (statuses.some((status) => status === "error")) return "error";
  if (statuses.some((status) => status === "running" || status === "pending")) return "running";
  return "done";
};
