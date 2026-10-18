const SENSITIVE_EXTENSIONS = [".pem", ".key", ".ppk", ".p12", ".pfx", ".crt", ".cer", ".der", ".jks", ".keystore", ".gpg"];
const PRIVATE_KEY_NAMES = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
const ENV_FILE_PATTERN = /^\.env($|\.)/;
const ENV_TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist"];
const VERSION_CONTROL_FOLDER = ".git";

const segmentsOf = (path: string): string[] => path.toLowerCase().split(/[\\/]+/).filter(Boolean);

export const isSensitivePath = (path: string): boolean => {
  const segments = segmentsOf(path);
  const name = segments.at(-1) ?? "";
  if (segments.includes(VERSION_CONTROL_FOLDER)) return true;
  if (ENV_FILE_PATTERN.test(name)) return !ENV_TEMPLATE_SUFFIXES.some((suffix) => name.endsWith(suffix));
  if (PRIVATE_KEY_NAMES.includes(name)) return true;
  return SENSITIVE_EXTENSIONS.some((extension) => name.endsWith(extension));
};

export const sensitivePathsOf = (paths: string[]): string[] => [...new Set(paths.filter(isSensitivePath))];

export const describeSensitiveFiles = (paths: string[]): string =>
  `These files may hold secrets (passwords, tokens, private keys):\n\n${paths.map((path) => `• ${path}`).join("\n")}\n\nIf you continue, their content is sent to the AI provider of this project's runtime. Continue only if you are sure.`;
