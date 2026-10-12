import type { CatalogModel } from "@branchboard/core";
import { finishNatives, numberOf, parseJson, type ApiProvider } from "./apiRuntime";
import { KNOWN_CLAUDE_MODELS } from "./claudeModels";

const API_VERSION = "2023-06-01";
const MAX_OUTPUT_TOKENS = 8192;
const SETUP_ERROR_TYPES = ["authentication_error", "permission_error"];
const CUT_OFF_NOTE = "\n\n_(The answer was cut off at the output limit.)_";

const fallbackModels: CatalogModel[] = KNOWN_CLAUDE_MODELS.map((model) => ({ ...model, provider: "anthropic" }));

export const anthropicProvider: ApiProvider = {
  id: "anthropic",
  fallbackModels,
  headers: (key) => ({ "x-api-key": key ?? "", "anthropic-version": API_VERSION }),
  chatUrl: (baseUrl) => `${baseUrl}/v1/messages`,
  modelsUrl: (baseUrl) => `${baseUrl}/v1/models?limit=100`,
  chatBody: ({ model, system, text, images }) => ({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
    ...(system ? { system } : {}),
    messages: [{ role: "user", content: [...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mime, data: image.base64 } })), { type: "text", text }] }],
  }),
  parseModels: (json) =>
    (Array.isArray((json as { data?: unknown })?.data) ? (json as { data: any[] }).data : [])
      .filter((entry) => typeof entry?.id === "string")
      .map((entry): CatalogModel => ({ id: entry.id, name: typeof entry.display_name === "string" ? entry.display_name : entry.id, provider: "anthropic", contextWindow: numberOf(entry.max_input_tokens) })),
  errorMessageOf: (json) => (typeof json?.error?.message === "string" ? json.error.message : undefined),
  translate: (data, state) => {
    const event = parseJson(data);
    if (!event) return [];
    if (event.type === "message_start") {
      const usage = event.message?.usage ?? {};
      state.cacheReadTokens = usage.cache_read_input_tokens ?? 0;
      state.cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
      state.inputTokens = (usage.input_tokens ?? 0) + state.cacheReadTokens + state.cacheCreationTokens;
      state.outputTokens = usage.output_tokens ?? 0;
      return [];
    }
    if (event.type === "content_block_delta") {
      const delta = event.delta ?? {};
      if (delta.type === "text_delta") return [{ type: "text", partId: "text", delta: delta.text }];
      if (delta.type === "thinking_delta") return [{ type: "reasoning", partId: "reasoning", delta: delta.thinking }];
      return [];
    }
    if (event.type === "message_delta") {
      state.outputTokens = event.usage?.output_tokens ?? state.outputTokens;
      state.finishReason = event.delta?.stop_reason ?? state.finishReason;
      return state.finishReason === "max_tokens" ? [{ type: "text", partId: "text", delta: CUT_OFF_NOTE }] : [];
    }
    if (event.type === "message_stop") return finishNatives(state);
    if (event.type === "error") return [{ type: "failure", message: event.error?.message ?? "The provider reported an error", recovery: SETUP_ERROR_TYPES.includes(event.error?.type) ? "setup" : undefined }];
    return [];
  },
};
