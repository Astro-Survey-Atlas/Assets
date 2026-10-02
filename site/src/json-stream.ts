export interface JsonStreamEvent { event: string; value: Record<string, unknown> }
/** Fetch POST streams while preserving compatibility with existing JSON endpoints. */
export async function readJsonResponse<T>(response: Response, update?: (event: JsonStreamEvent) => void): Promise<T> {
  if (!response.headers.get("Content-Type")?.includes("text/event-stream")) return response.json() as Promise<T>;
  if (!response.body) throw new Error("Query stream is unavailable");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read(); buffer += decoder.decode(chunk.value, { stream: !chunk.done }).replace(/\r\n/g, "\n");
      if (buffer.length > 8 * 1024 * 1024) throw new Error("Query stream event exceeded its budget");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const lines = frame.split("\n");
        const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim() ?? "message";
        const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const value = JSON.parse(data) as Record<string, unknown>;
        if (event === "error") throw new Error(String(value.error ?? "Query failed"));
        if (event === "complete") return value as T;
        update?.({ event, value });
      }
      if (chunk.done) throw new Error("Query stream ended before the frozen result completed");
    }
  } finally { await reader.cancel().catch(() => undefined); }
}
