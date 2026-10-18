#!/usr/bin/env node
import { createInterface } from "node:readline";

const VERSION = "codex-cli 0.163.0";

if (process.argv.includes("--version")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

let nextThread = 1;
let nextTurn = 1;
let nextServerRequest = 100;
const waiting = new Map();
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerRequest++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const rateLimits = { limitId: "codex", primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 }, rateLimitReachedType: null };

const runTurn = async (threadId, turnId, text) => {
  notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress", items: [] } });
  let answer = `Echo: ${text}`;
  if (text.includes("approve")) {
    const item = { type: "commandExecution", id: `cmd-${turnId}`, command: "/bin/bash -lc 'npm test'", commandActions: [{ type: "unknown", command: "npm test" }], status: "inProgress", aggregatedOutput: null, exitCode: null };
    notify("item/started", { threadId, turnId, item });
    const reply = await ask("item/commandExecution/requestApproval", { threadId, turnId, itemId: item.id, command: item.command, commandActions: item.commandActions, availableDecisions: ["accept", "acceptForSession", "decline", "cancel"] });
    const accepted = reply.result?.decision === "accept" || reply.result?.decision === "acceptForSession";
    notify("item/completed", { threadId, turnId, item: { ...item, status: accepted ? "completed" : "declined", aggregatedOutput: accepted ? "1 passing" : "", exitCode: accepted ? 0 : null } });
    answer = accepted ? "Ran npm test" : "Skipped npm test";
  }
  notify("item/agentMessage/delta", { threadId, turnId, itemId: `msg-${turnId}`, delta: answer });
  notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg-${turnId}`, text: answer } });
  const usage = { totalTokens: 60, inputTokens: 50, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 };
  notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: usage, last: usage, modelContextWindow: 200000 } });
  notify("account/rateLimits/updated", { rateLimits });
  notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [], error: null } });
};

const handlers = {
  initialize: () => ({ userAgent: "fake-codex", codexHome: "/fake", platformFamily: "unix", platformOs: "linux" }),
  "account/read": () => ({ account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true }),
  "account/rateLimits/read": () => ({ rateLimits }),
  "model/list": () => ({ data: [{ id: "gpt-fake", displayName: "GPT Fake", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] }], nextCursor: null }),
  "skills/list": (params) => ({ data: [{ cwd: params.cwds?.[0] ?? "", skills: [], errors: [] }] }),
  "windowsSandbox/readiness": () => ({ status: "ready" }),
  "thread/start": () => ({ thread: { id: `thread-${nextThread++}` } }),
  "thread/fork": () => ({ thread: { id: `thread-${nextThread++}` } }),
  "thread/delete": () => ({}),
  "turn/interrupt": (params) => {
    notify("turn/completed", { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted", items: [], error: null } });
    return {};
  },
  "turn/steer": (params) => ({ turnId: params.expectedTurnId }),
  "turn/start": (params) => {
    const turnId = `turn-${nextTurn++}`;
    setTimeout(() => void runTurn(params.threadId, turnId, params.input?.[0]?.text ?? ""), 20);
    return { turn: { id: turnId, status: "inProgress", items: [] } };
  },
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
  if (message.id === undefined) return;
  const handler = handlers[message.method];
  if (!handler) return send({ id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } });
  send({ id: message.id, result: handler(message.params ?? {}) });
});
