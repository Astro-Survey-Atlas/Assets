/**
 * Phase and MOC-build presentation shared by every admin renderer.
 *
 * One `mocBuildView` per build record: the four historical renderers (product fact row,
 * build detail dialog, outputs card row, detail summary) parsed `MocBuildRequest`
 * independently and disagreed — most visibly, the card row's busy check tested scan-task
 * phases, so a FETCHING/BUILDING build never showed its progress. Everything derives
 * from this module now.
 */

import { escapeHtml } from "../src/dom.js";

export function phaseLabel(phase?: string): string {
  const normalized = String(phase ?? "").trim().toUpperCase();
  return normalized || "PENDING";
}

export function phaseClass(phase: string): string {
  return (phase || "PENDING").toLowerCase().replace(/[^a-z]+/g, "-");
}

export function phaseIcon(phase?: string): string {
  const value = phaseLabel(phase);
  if (["SUCCEEDED", "COMPLETED", "STAGED", "PUBLISHED", "ACTIVE"].includes(value)) return "circle-check";
  if (["FAILED", "ERROR", "INVALID", "CANCELLED"].includes(value)) return "circle-alert";
  if (["RUNNING", "PROBING", "PROCESSING"].includes(value)) return "loader-circle";
  return "circle-dot";
}

export function phaseMarkup(phase: string | undefined, prefix = ""): string {
  const label = `${prefix}${phaseLabel(phase)}`;
  return `<span class="task-phase task-phase-${phaseClass(phase ?? "PENDING")}" title="${escapeHtml(label)}"><i data-lucide="${phaseIcon(phase)}"></i><span>${escapeHtml(label)}</span></span>`;
}

export function taskMetric(icon: string, label: string, value: string | number): string {
  return `<span class="task-metric"><i data-lucide="${icon}"></i><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></span>`;
}

export function orderLabel(orders?: number[]): string {
  return orders?.length ? orders.map((order) => `O${order}`).join(" / ") : "--";
}

/** MocBuildPhase terminal values; everything else (QUEUED, FETCHING, BUILDING, …) is in flight. */
const BUILD_TERMINAL_PHASES = new Set(["STAGED", "FAILED", "DUPLICATE"]);

export interface MocBuildLike {
  phase?: string;
  progress?: { percent?: number; message?: string; step?: number; totalSteps?: number };
  outputs?: { availableOrders?: number[]; cellCount?: number };
  publishedAt?: string;
}

export interface MocBuildView {
  phase: string;
  phaseClass: string;
  icon: string;
  busy: boolean;
  /** Clamped 0–100 while the build is in flight; undefined at rest. */
  percent: number | undefined;
  ordersText: string;
  cellCountText: string;
  /** The one canonical summary line for fact rows. */
  summary: string;
}

export function mocBuildView(build: MocBuildLike | undefined): MocBuildView | null {
  if (!build) return null;
  const phase = phaseLabel(build.phase);
  const busy = !BUILD_TERMINAL_PHASES.has(phase);
  const rawPercent = build.progress?.percent;
  const percent = busy && typeof rawPercent === "number"
    ? Math.max(0, Math.min(100, rawPercent))
    : undefined;
  const ordersText = orderLabel(build.outputs?.availableOrders);
  const cellCountText = build.outputs?.cellCount !== undefined
    ? build.outputs.cellCount.toLocaleString("en-US")
    : "—";
  const parts = [phase];
  if (percent !== undefined) parts.push(`${percent}%`);
  if (build.outputs?.cellCount !== undefined) parts.push(`${cellCountText} 单元`);
  if (build.outputs?.availableOrders?.length) parts.push(ordersText);
  if (build.publishedAt) parts.push("已发布");
  return {
    phase,
    phaseClass: phaseClass(phase),
    icon: phaseIcon(phase),
    busy,
    percent,
    ordersText,
    cellCountText,
    summary: parts.join(" · "),
  };
}
