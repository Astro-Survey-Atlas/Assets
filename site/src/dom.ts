/** Shared DOM and formatting helpers used by every page entry point. */

/** Required element lookup: throws when the markup is missing an expected id. */
export function byId<T extends HTMLElement | SVGElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}

/** Optional element lookup for overlays that appear and disappear. */
export function byIdOrNull<T extends HTMLElement | SVGElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function setTextIfPresent(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

/** Shared toast timer: one message at a time per page. */
let toastTimer: number | undefined;

export function toast(id: string, message: string, options: { durationMs?: number; error?: boolean } = {}): void {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = message;
  if (options.error !== undefined) element.dataset.error = options.error ? "true" : "false";
  element.dataset.visible = "true";
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { element.dataset.visible = "false"; }, options.durationMs ?? 1800);
}

/** Bytes with binary units; unknown values return the given fallback. */
export function formatBytes(value: number | undefined, fallback = "未知"): string {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}
