import { isUsageLimitMessage } from "./kit/usageLimit";

export const RECOVERY_IDS = ["assemble", "setup", "signIn", "usageLimit", "report", "retry"] as const;

export type RecoveryId = (typeof RECOVERY_IDS)[number];

export const isRecoveryId = (value: unknown): value is RecoveryId => RECOVERY_IDS.includes(value as RecoveryId);

const MESSAGE_RECOVERIES: { matches: (message: string) => boolean; recovery: RecoveryId }[] = [{ matches: isUsageLimitMessage, recovery: "usageLimit" }];

export const recoveryOfMessage = (message: string): RecoveryId | undefined => MESSAGE_RECOVERIES.find((entry) => entry.matches(message))?.recovery;

export const SESSION_GONE_MESSAGE = "This branch's saved session is gone (it may have been cleared). Resend the context as text?";
