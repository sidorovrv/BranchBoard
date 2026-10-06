import { newId, parseTodoItems, REJECTED_ANSWER, type QuestionSpec } from "@branchboard/core";
import type { EventMap, RunScope, RuntimeSteps } from "../run/types";
import { subagentEventMap, type LooseNative } from "./commonEvents";

type FakeEvent =
  | { type: "chunk"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; id: string; description: string }
  | { type: "approval"; id: string; title: string }
  | { type: "question"; id: string; questions: QuestionSpec[] }
  | { type: "tool-result"; id: string; output: string; isError: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "failure"; message: string }
  | { type: "todos"; items: { content: string; status: string }[] }
  | { type: "subagent-start"; key: string; title: string }
  | { type: "subagent-done"; key: string }
  | { type: "sub"; key: string; inner: FakeEvent };

interface FakeSession {
  sessionId: string;
  history: string;
}

const histories = new Map<string, string>();

const fakeQuestions: QuestionSpec[] = [
  { question: "Which fruit should I use?", header: "Fruit", options: [{ label: "apple", description: "Crisp" }, { label: "banana" }] },
  { question: "Which toppings?", header: "Toppings", multiple: true, options: [{ label: "cream" }, { label: "nuts" }] },
];

const CHUNK_SIZE = 14;
const FAST_DELAY_MS = 8;
const SLOW_DELAY_MS = 120;

const pause = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

const chunksOf = (text: string): string[] => text.match(new RegExp(`[\\s\\S]{1,${CHUNK_SIZE}}`, "g")) ?? [];

const echoText = (input: string, scope: RunScope): string => `[fake ${scope.agent ?? "default"}/${scope.model ?? "default"}] received:\n${input}`;

async function* execute(session: FakeSession, input: string, scope: RunScope): AsyncGenerator<FakeEvent> {
  const prompt = input.split("\n").at(-1) ?? "";
  const delay = prompt.includes("/slow") ? SLOW_DELAY_MS : FAST_DELAY_MS;
  const fullInput = `${session.history}${input}`;
  scope.setRuntimeRef({ sessionId: session.sessionId, lastMessageId: `fake-msg-${scope.nodeId}` });
  yield { type: "reasoning", text: "Reading the context. " };
  if (prompt.startsWith("/tool")) {
    const id = newId();
    yield { type: "tool", id, description: "Reads the project notes" };
    yield { type: "approval", id, title: "Allow reading the project notes?" };
    const answer = await scope.waitForAnswer(id);
    yield { type: "tool-result", id, output: answer === "reject" ? "Rejected by the user" : "ok", isError: answer === "reject" };
  }
  if (prompt.startsWith("/ask")) {
    const id = newId();
    yield { type: "tool", id, description: "Asks the user a question" };
    yield { type: "question", id, questions: fakeQuestions };
    const reply = await scope.waitForAnswer(id);
    yield { type: "tool-result", id, output: reply, isError: reply === REJECTED_ANSWER };
  }
  if (prompt.startsWith("/fail")) {
    yield { type: "failure", message: "The provider failed" };
    return;
  }
  if (prompt.startsWith("/limit")) {
    yield { type: "failure", message: "You've hit your session limit · resets 7:30pm (Europe/Paris)" };
    return;
  }
  if (prompt.startsWith("/todo")) {
    yield { type: "todos", items: [{ content: "Read the notes", status: "completed" }, { content: "Write the answer", status: "in_progress" }] };
  }
  if (prompt.startsWith("/subagent")) {
    yield { type: "subagent-start", key: "sub-1", title: "Helper" };
    yield { type: "sub", key: "sub-1", inner: { type: "chunk", text: "helper says hi" } };
    if (prompt.includes("ask")) {
      const id = newId();
      yield { type: "sub", key: "sub-1", inner: { type: "approval", id, title: "Allow the helper?" } };
      await scope.waitForAnswer(id);
    }
    yield { type: "subagent-done", key: "sub-1" };
  }
  const answer = echoText(fullInput, scope);
  for (const text of chunksOf(answer)) {
    if (scope.signal.aborted) return;
    yield { type: "chunk", text };
    await pause(delay, scope.signal);
  }
  histories.set(session.sessionId, `${fullInput}\n${answer}\n`);
  yield { type: "usage", inputTokens: Math.ceil(fullInput.length / 4), outputTokens: Math.ceil(answer.length / 4) };
}

const eventMap: EventMap<FakeEvent> = {
  ...(subagentEventMap(() => eventMap as unknown as EventMap<LooseNative>) as unknown as EventMap<FakeEvent>),
  failure: (native) => [{ type: "error", message: (native as Extract<FakeEvent, { type: "failure" }>).message }],
  todos: (native) => [{ type: "todos", items: parseTodoItems((native as Extract<FakeEvent, { type: "todos" }>).items) }],
  chunk: (native) => [{ type: "part.delta", partKey: "text", partType: "text", text: (native as Extract<FakeEvent, { type: "chunk" }>).text }],
  reasoning: (native) => [{ type: "part.delta", partKey: "reasoning", partType: "reasoning", text: (native as Extract<FakeEvent, { type: "reasoning" }>).text }],
  tool: (native) => {
    const { id, description } = native as Extract<FakeEvent, { type: "tool" }>;
    return [{ type: "tool.started", partKey: `tool:${id}`, tool: "read", description }];
  },
  approval: (native) => {
    const { id, title } = native as Extract<FakeEvent, { type: "approval" }>;
    return [{ type: "request.opened", request: { id, kind: "approval", title, options: ["once", "always", "reject"] } }];
  },
  question: (native) => {
    const { id, questions } = native as Extract<FakeEvent, { type: "question" }>;
    const title = questions.map((entry) => entry.question).join("\n");
    return [{ type: "request.opened", request: { id, kind: "question", title, options: [], questions } }];
  },
  "tool-result": (native) => {
    const { id, output, isError } = native as Extract<FakeEvent, { type: "tool-result" }>;
    return [{ type: "tool.done", partKey: `tool:${id}`, output, isError }];
  },
  usage: (native) => {
    const { inputTokens, outputTokens } = native as Extract<FakeEvent, { type: "usage" }>;
    return [{ type: "usage", usage: { inputTokens, outputTokens } }];
  },
};

export const fakeRuntime: RuntimeSteps<FakeEvent, FakeSession> = {
  id: "fake",
  catalog: async () => ({
    agents: ["build", "plan"],
    models: [
      { id: "fake/echo", name: "Echo", provider: "fake", contextWindow: 32000, efforts: ["default", "low", "high"] },
      { id: "fake/echo-large", name: "Echo Large", provider: "fake", contextWindow: 128000 },
    ],
    permissionModes: [
      { id: "edit", name: "Accept edits" },
      { id: "plan", name: "Plan" },
    ],
    defaultPermissionMode: "edit",
    commands: [{ name: "review", description: "Review something", template: "Please review: $ARGUMENTS" }],
    health: { ok: true, detail: "built-in fake runtime" },
  }),
  openSession: async (plan, scope) => ({
    sessionId: `fake-${scope.nodeId}`,
    history: plan.spine ? (histories.get(plan.spine.runtimeRef.sessionId) ?? "") : "",
  }),
  execute,
  eventMap,
  answerRequest: async () => undefined,
};
