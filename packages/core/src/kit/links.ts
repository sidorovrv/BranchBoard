export type LinkTarget = { kind: "web"; href: string } | { kind: "file"; path: string; hash: string };

const WEB_PROTOCOL_PATTERN = /^([a-z][a-z0-9+.-]+:|\/\/)/i;
const FILE_URL_PATTERN = /^file:\/\//i;

const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

const withoutDriveSlash = (path: string): string => (/^\/[a-zA-Z]:\//.test(path) ? path.slice(1) : path);

const splitHash = (href: string): { path: string; hash: string } => {
  const at = href.indexOf("#");
  return at < 0 ? { path: href, hash: "" } : { path: href.slice(0, at), hash: href.slice(at) };
};

export const linkTargetOf = (href: string): LinkTarget => {
  if (FILE_URL_PATTERN.test(href)) {
    const { path, hash } = splitHash(href.replace(FILE_URL_PATTERN, ""));
    return { kind: "file", path: withoutDriveSlash(decoded(path)), hash };
  }
  if (href.startsWith("#") || WEB_PROTOCOL_PATTERN.test(href)) return { kind: "web", href };
  const { path, hash } = splitHash(href);
  return { kind: "file", path: decoded(path), hash };
};
