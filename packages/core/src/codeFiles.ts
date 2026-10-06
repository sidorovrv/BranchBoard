const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  xml: "xml",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  cs: "csharp",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  sh: "bash",
  ps1: "powershell",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  txt: "text",
  csv: "text",
  svg: "xml",
};

export const MAX_EXTRACTED_FILE_BYTES = 400_000;

const PATH_PATTERN = /^(?:[A-Za-z]:)?[\w@.\-/\\]*[\w@-]\.([A-Za-z0-9]{1,5})$/;

export const extensionOfPath = (path: string): string => {
  const name = fileNameOf(path);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

export const fileNameOf = (path: string): string => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

export const languageOfPath = (path: string): string | undefined => LANGUAGE_BY_EXTENSION[extensionOfPath(path)];

const TEXT_MIME_TYPES = ["application/json", "application/xml", "application/x-yaml"];

export const isTextAttachment = (attachment: { name: string; mime: string; size: number }): boolean =>
  attachment.size <= MAX_EXTRACTED_FILE_BYTES && (languageOfPath(attachment.name) !== undefined || attachment.mime.startsWith("text/") || TEXT_MIME_TYPES.includes(attachment.mime));

export const isMarkdownPath = (path: string): boolean => ["md", "markdown"].includes(extensionOfPath(path));

export const looksLikeFilePath =(text: string): boolean => {
  const match = PATH_PATTERN.exec(text.trim());
  return Boolean(match) && match![1].toLowerCase() in LANGUAGE_BY_EXTENSION;
};

const TOOL_PATH_KEYS = ["file_path", "filePath", "path", "notebook_path"];

export const toolFilePathOf = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const key = TOOL_PATH_KEYS.find((candidate) => typeof record[candidate] === "string" && looksLikeFilePath(record[candidate] as string));
  return key ? (record[key] as string) : undefined;
};
