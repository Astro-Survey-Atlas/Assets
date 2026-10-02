import type { IncomingMessage, ServerResponse } from "node:http";

/** Optional SSE transport. The final event is the same frozen JSON response. */
export class ReverseStream {
  readonly enabled: boolean;
  #started = false;
  readonly #response: ServerResponse;
  constructor(request: IncomingMessage, response: ServerResponse) { this.enabled = String(request.headers.accept ?? "").split(",").some(type => type.trim().split(";")[0] === "text/event-stream"); this.#response = response; }
  emit(event: "progress" | "batch" | "complete" | "error", value: unknown): void {
    if (!this.enabled || this.#response.destroyed || this.#response.writableEnded) return;
    if (!this.#started) {
      this.#response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      this.#response.flushHeaders(); this.#started = true;
    }
    this.#response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
    if (event === "complete" || event === "error") this.#response.end();
  }
}
