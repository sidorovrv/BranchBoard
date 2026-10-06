const EXTERNAL_PATTERN = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

export const isExternalReference = (reference: string): boolean => EXTERNAL_PATTERN.test(reference.trim());

export const resolveRelativePath = (fromFilePath: string, reference: string): string | undefined => {
  const cleaned = decodeURI(reference.trim().split(/[?#]/)[0]).replace(/\\/g, "/");
  if (!cleaned || isExternalReference(cleaned)) return undefined;
  const segments = cleaned.startsWith("/") ? [] : fromFilePath.replace(/\\/g, "/").split("/").slice(0, -1);
  for (const part of cleaned.split("/")) {
    if (part === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
    } else if (part !== "." && part !== "") segments.push(part);
  }
  return segments.join("/");
};
