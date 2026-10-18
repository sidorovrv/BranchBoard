const USAGE_LIMIT_PATTERN = /hit your [\w ]{0,30}limit|usage limit|rate[ _-]?limit|quota (?:exceeded|exhausted|reached)|exceeded your [\w ]{0,30}quota/i;

export const isUsageLimitMessage = (message: string): boolean => USAGE_LIMIT_PATTERN.test(message);
