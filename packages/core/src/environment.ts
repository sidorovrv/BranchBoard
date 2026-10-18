export const MAX_ENVIRONMENT_VARIABLES = 50;
export const MAX_ENVIRONMENT_VALUE_CHARS = 4000;

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_NAMES = new Set(["PATH", "HOME", "USERPROFILE", "SHELL", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS"]);

export const parseEnvironmentText = (text: string): Record<string, string> => {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (lines.length > MAX_ENVIRONMENT_VARIABLES) throw new Error(`At most ${MAX_ENVIRONMENT_VARIABLES} variables are allowed`);
  const entries = lines.map((line) => {
    const separator = line.indexOf("=");
    const name = separator < 0 ? line : line.slice(0, separator).trim();
    const value = separator < 0 ? "" : line.slice(separator + 1);
    if (!NAME_PATTERN.test(name)) throw new Error(`"${name}" is not a valid variable name`);
    if (RESERVED_NAMES.has(name.toUpperCase())) throw new Error(`${name} cannot be set`);
    if (value.length > MAX_ENVIRONMENT_VALUE_CHARS || value.includes("\0")) throw new Error(`The value of ${name} is not allowed`);
    return [name, value] as const;
  });
  return Object.fromEntries(entries);
};

export const environmentTextOf = (environment: Record<string, string> | undefined): string =>
  Object.entries(environment ?? {}).map(([name, value]) => `${name}=${value}`).join("\n");
