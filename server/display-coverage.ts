import type { NativeMoc } from "./native-moc.js";
import { healpixRanges } from "./healpix-list.js";

export const DISPLAY_BLOCK_PIXELS = 4096;
export const MAX_DISPLAY_TILE_RANGES = 250_000;

export interface PixelRange {
  start: number;
  end: number;
}

export function displayOrders(prebuiltOrders: readonly number[], moc?: NativeMoc): number[] {
  if (moc) return Array.from({ length: moc.maxOrder - 3 }, (_, index) => index + 4);
  return [...new Set(prebuiltOrders.filter((order) => order >= 4))].sort((a, b) => a - b);
}

export function mergedPixelRanges(ranges: readonly (readonly [number, number])[]): PixelRange[] {
  const merged: PixelRange[] = [];
  for (const [start, end] of ranges) {
    const previous = merged.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else merged.push({ start, end });
  }
  return merged;
}

export function intersectPixelRanges(left: readonly PixelRange[], right: readonly PixelRange[]): PixelRange[] {
  const result: PixelRange[] = [];
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    const first = left[a]!;
    const second = right[b]!;
    const start = Math.max(first.start, second.start);
    const end = Math.min(first.end, second.end);
    if (start < end) result.push({ start, end });
    if (first.end <= second.end) a += 1;
    else b += 1;
  }
  return result;
}

export function rangesForCells(cells: readonly number[]): PixelRange[] {
  return mergedPixelRanges([...cells].sort((a, b) => a - b).map((pixel) => [pixel, pixel + 1] as const));
}

export function mocPixelRanges(moc: NativeMoc, order: number): PixelRange[] {
  if (!Number.isSafeInteger(order) || order < 0 || order > moc.maxOrder) throw new Error("Unsupported projection order");
  return healpixRanges([moc], order).map(([start, end]) => ({ start, end }));
}

export function displayTileRanges(ranges: readonly PixelRange[], tilePixels = DISPLAY_BLOCK_PIXELS): PixelRange[] {
  return mergedPixelRanges(ranges.map(({ start, end }) => [Math.floor(start / tilePixels), Math.ceil(end / tilePixels)] as const));
}

export function pixelsInTile(ranges: readonly PixelRange[], tileId: number, limit = DISPLAY_BLOCK_PIXELS): number[] {
  if (!Number.isSafeInteger(tileId) || tileId < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid display tile");
  const start = tileId * DISPLAY_BLOCK_PIXELS;
  const end = start + DISPLAY_BLOCK_PIXELS;
  const pixels: number[] = [];
  for (const range of ranges) {
    if (range.end <= start) continue;
    if (range.start >= end) break;
    for (let pixel = Math.max(start, range.start); pixel < Math.min(end, range.end); pixel += 1) {
      if (pixels.length >= limit) throw new Error("Display tile exceeds its cell budget");
      pixels.push(pixel);
    }
  }
  return pixels;
}

export function expandPixelRanges(ranges: readonly PixelRange[], limit: number): number[] {
  const count = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  if (count > limit) throw new Error(`Coverage contains ${count} cells and exceeds the ${limit}-cell render budget`);
  const cells = new Array<number>(count);
  let offset = 0;
  for (const { start, end } of ranges) for (let pixel = start; pixel < end; pixel += 1) cells[offset++] = pixel;
  return cells;
}
