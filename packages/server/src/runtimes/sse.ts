const MAX_PENDING_CHARS = 8 * 1024 * 1024;

const dataOf = (block: string): string | undefined => {
  const lines = block.split("\n").filter((line) => line.startsWith("data:"));
  return lines.length === 0 ? undefined : lines.map((line) => line.slice(5).replace(/^ /, "")).join("\n");
};

export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let heldReturn = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = heldReturn + decoder.decode(value, { stream: true });
      heldReturn = chunk.endsWith("\r") ? "\r" : "";
      pending += chunk.slice(0, chunk.length - heldReturn.length).replace(/\r\n?/g, "\n");
      if (pending.length > MAX_PENDING_CHARS) throw new Error("The server sent an event that is too large");
      let boundary = pending.indexOf("\n\n");
      while (boundary >= 0) {
        const data = dataOf(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
        if (data !== undefined) yield data;
        boundary = pending.indexOf("\n\n");
      }
    }
    const last = dataOf(pending + (heldReturn + decoder.decode()).replace(/\r\n?/g, "\n"));
    if (last !== undefined) yield last;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
