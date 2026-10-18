export interface PromptSegment {
  kind: "text" | "code";
  text: string;
  language?: string;
}

export const FENCE_WITH_LANGUAGE = /^\s*```([\w+#.-]*)\s*$/;

const trimBlankEdges = (text: string): string => text.replace(/^\n+|\n+$/g, "");

export const splitPromptSegments = (prompt: string): PromptSegment[] => {
  const segments: PromptSegment[] = [];
  let current: { segment: PromptSegment; lines: string[] } | undefined;
  const close = () => {
    if (current) segments.push({ ...current.segment, text: current.segment.kind === "text" ? trimBlankEdges(current.lines.join("\n")) : current.lines.join("\n") });
    current = undefined;
  };
  for (const line of prompt.split("\n")) {
    const opener = current?.segment.kind === "code" ? undefined : FENCE_WITH_LANGUAGE.exec(line);
    if (opener) {
      close();
      current = { segment: { kind: "code", text: "", language: opener[1] || undefined }, lines: [] };
    } else if (current?.segment.kind === "code" && line.trim() === "```") close();
    else {
      current ??= { segment: { kind: "text", text: "" }, lines: [] };
      current.lines.push(line);
    }
  }
  close();
  return segments.filter((segment) => segment.kind === "code" || segment.text.trim() !== "");
};

export const isLongPrompt = (prompt: string, maxLines: number, maxCharacters = 320): boolean =>
  prompt.length > maxCharacters || prompt.split("\n").length > maxLines || prompt.includes("```");
