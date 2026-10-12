import type { CatalogModel } from "@branchboard/core";
import { finishNatives, numberOf, parseJson, type ApiProvider } from "./apiRuntime";

const DONE_MARKER = "[DONE]";
const SETUP_ERROR_CODES = ["invalid_api_key", "authentication_error", "invalid_authentication"];
const CUT_OFF_NOTE = "\n\n_(The answer was cut off at the output limit.)_";

export const openaiProvider: ApiProvider = {
  id: "openai",
  fallbackModels: [],
  headers: (key): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {}),
  chatUrl: (baseUrl) => `${baseUrl}/chat/completions`,
  modelsUrl: (baseUrl) => `${baseUrl}/models`,
  chatBody: ({ model, system, text, images }) => ({
    model,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: images.length === 0 ? text : [{ type: "text", text }, ...images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } }))] },
    ],
  }),
  parseModels: (json) =>
    (Array.isArray((json as { data?: unknown })?.data) ? (json as { data: any[] }).data : [])
      .filter((entry) => typeof entry?.id === "string")
      .map((entry): CatalogModel => ({ id: entry.id, name: typeof entry.name === "string" ? entry.name : entry.id, provider: "openai", contextWindow: numberOf(entry.context_length) ?? numberOf(entry.context_window) })),
  errorMessageOf: (json) => (typeof json?.error?.message === "string" ? json.error.message : typeof json?.error === "string" ? json.error : undefined),
  translate: (data, state) => {
    if (data === DONE_MARKER) return finishNatives(state);
    const chunk = parseJson(data);
    if (!chunk) return [];
    if (chunk.error) {
      const code = String(chunk.error.code ?? chunk.error.type ?? "");
      return [{ type: "failure", message: chunk.error.message ?? "The provider reported an error", recovery: SETUP_ERROR_CODES.includes(code) ? "setup" : undefined }];
    }
    if (chunk.usage) {
      state.inputTokens = chunk.usage.prompt_tokens ?? state.inputTokens;
      state.outputTokens = chunk.usage.completion_tokens ?? state.outputTokens;
      state.cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? state.cacheReadTokens;
    }
    const choice = chunk.choices?.[0];
    if (!choice) return [];
    const natives: { type: string; partId: string; delta: string }[] = [];
    const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
    if (typeof reasoning === "string" && reasoning) natives.push({ type: "reasoning", partId: "reasoning", delta: reasoning });
    if (typeof choice.delta?.content === "string" && choice.delta.content) natives.push({ type: "text", partId: "text", delta: choice.delta.content });
    if (choice.finish_reason) {
      state.finishReason = choice.finish_reason;
      if (choice.finish_reason === "length") natives.push({ type: "text", partId: "text", delta: CUT_OFF_NOTE });
    }
    return natives;
  },
};
