interface ProviderModel {
  id: string;
  status?: string;
  cost?: { input?: number; output?: number };
  limit?: { context?: number };
}

interface ProviderEntry {
  id: string;
  models?: Record<string, ProviderModel>;
}

const NOT_FOR_TEXT = /embed|whisper|tts|image|moderation|audio|realtime|transcribe/i;
const LIGHT_NAMES = /nano|mini|flash|haiku|small|lite|fast|air|instant/i;

const priceOf = (model: ProviderModel): number => (model.cost?.input ?? Number.POSITIVE_INFINITY) + (model.cost?.output ?? Number.POSITIVE_INFINITY);

const lightness = (model: ProviderModel): number => (LIGHT_NAMES.test(model.id) ? 0 : 1);

const byCheapness = (left: ProviderModel, right: ProviderModel): number =>
  priceOf(left) - priceOf(right) || lightness(left) - lightness(right) || (left.limit?.context ?? 0) - (right.limit?.context ?? 0) || left.id.localeCompare(right.id);

const hasKnownPrice = (model: ProviderModel): boolean => Number.isFinite(priceOf(model));

export const pickSmallModel = (providers: ProviderEntry[], currentModel: string | undefined): string | undefined => {
  const providerId = currentModel?.split("/")[0];
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (!provider) return undefined;
  const usable = Object.values(provider.models ?? {}).filter((model) => model.status !== "deprecated" && !NOT_FOR_TEXT.test(model.id));
  const priced = usable.filter(hasKnownPrice);
  const pool = priced.length > 0 ? priced : usable.filter((model) => lightness(model) === 0);
  const chosen = [...pool].sort(byCheapness)[0];
  return chosen ? `${provider.id}/${chosen.id}` : undefined;
};
