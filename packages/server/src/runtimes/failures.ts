import { isUsageLimitMessage, redactSecrets, type RecoveryId } from "@branchboard/core";

export const CUT_OFF_NOTE = "\n\n_(The answer was cut off at the output limit.)_";
export const STEPS_LIMIT_MESSAGE = "Tools are disabled after the maximum agent steps";
export const STEPS_LIMIT_NOTE = "\n\n_(The agent stopped at its step limit.)_";
export const STREAM_ENDED_EARLY = "The connection closed before the answer finished";
export const REQUEST_TIMED_OUT = "The server did not answer in time";

export interface FailureSource {
  type?: string;
  tag?: string;
  status?: number;
  message?: string;
  body?: unknown;
  isTimeout?: boolean;
  isEarlyEnd?: boolean;
  isMissingEngine?: boolean;
}

export interface Failure {
  message: string;
  recovery?: RecoveryId;
}

const AUTH_STATUSES = [401, 403];
const RATE_LIMIT_STATUS = 429;
const BODY_CHARS = 300;
const KEY_ERROR_PATTERN = /api key|unauthori[sz]ed|authentication|invalid.{0,20}(key|token)/i;

export const redactFailureText = (text: string, secrets: readonly string[] = []): string => redactSecrets(text, { secrets: [...secrets] });

const bodyText = (body: unknown): string => {
  if (body === undefined || body === null || body === "") return "";
  return typeof body === "string" ? body : JSON.stringify(body);
};

export const recoveryOfFailure = (source: FailureSource): RecoveryId | undefined => {
  if (source.isMissingEngine || source.type === "provider.no-route") return "setup";
  if (source.tag === "ServiceUnavailableError" && KEY_ERROR_PATTERN.test(source.message ?? "")) return "signIn";
  if (source.type === "provider.auth" || (source.status !== undefined && AUTH_STATUSES.includes(source.status))) return "signIn";
  if (source.type === "provider.rate-limit" || source.status === RATE_LIMIT_STATUS) return "usageLimit";
  return undefined;
};

export const failureOf = (source: FailureSource, secrets: readonly string[] = []): Failure => {
  const base = source.isEarlyEnd ? STREAM_ENDED_EARLY : source.isTimeout ? REQUEST_TIMED_OUT : (source.message ?? source.type ?? "The request failed");
  const detail = bodyText(source.body);
  const message = detail && !base.includes(detail.slice(0, BODY_CHARS)) ? `${base}: ${detail.slice(0, BODY_CHARS)}` : base;
  return { message: redactFailureText(message, secrets), recovery: recoveryOfFailure(source) };
};

export const CODEX_SIGN_IN_STEP = "Run `codex login` in a terminal, then try again.";
const CODEX_USAGE_LIMIT_KINDS = ["usageLimitExceeded", "rateLimitExceeded"];
const UNAUTHORIZED_STATUS = 401;

const codexErrorKindOf = (info: unknown): string | undefined => (typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined);

const codexHttpStatusOf = (info: unknown): number | undefined => {
  const detail: any = info && typeof info === "object" ? Object.values(info)[0] : undefined;
  return typeof detail?.httpStatusCode === "number" ? detail.httpStatusCode : undefined;
};

export const codexFailureOf = (error: any): Failure => {
  const kind = codexErrorKindOf(error?.codexErrorInfo);
  const message = String(error?.message || "Codex stopped with an error");
  if (kind && CODEX_USAGE_LIMIT_KINDS.includes(kind)) return { message: redactFailureText(isUsageLimitMessage(message) ? message : `Codex usage limit reached: ${message}`), recovery: "usageLimit" };
  if (kind === "unauthorized" || codexHttpStatusOf(error?.codexErrorInfo) === UNAUTHORIZED_STATUS) return { message: redactFailureText(`${message}. ${CODEX_SIGN_IN_STEP}`), recovery: "setup" };
  if (kind === "contextWindowExceeded") return { message: redactFailureText(`${message}. Summarise the parents in the Context panel and run again.`) };
  const detail = error?.additionalDetails ? `: ${error.additionalDetails}` : "";
  return { message: redactFailureText(`${message}${detail}`), recovery: "report" };
};
