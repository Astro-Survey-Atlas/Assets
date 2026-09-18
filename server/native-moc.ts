import { createHash } from "node:crypto";

export interface MocCell { order: number; pixel: number }
export interface NativeMoc { cells: MocCell[]; availableOrders: number[]; maxOrder: number; revision: string; sha256: string }
export const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Decode the actual NUNIQ table, never the requested order in a source URL. */
export function decodeNativeMoc(bytes: Buffer): NativeMoc {
  if (bytes.length % 2880 || bytes.toString("ascii", 0, 8) !== "SIMPLE  ") throw new Error("Invalid FITS MOC");
  let offset = 0;
  while (offset < bytes.length) {
    const header = new Map<string, string>();
    let cursor = offset;
    let ended = false;
    while (cursor + 80 <= bytes.length) {
      const card = bytes.toString("ascii", cursor, cursor + 80); cursor += 80;
      const key = card.slice(0, 8).trim();
      if (key === "END") { ended = true; break; }
      if (card[8] === "=") header.set(key, card.slice(10).split("/", 1)[0]!.trim().replace(/^'|'$/g, "").trim());
    }
    if (!ended) throw new Error("Truncated FITS header");
    const start = offset + Math.ceil((cursor - offset) / 2880) * 2880;
    if (header.get("XTENSION") === "BINTABLE") {
      if (header.get("ORDERING") !== "NUNIQ" || header.get("COORDSYS") !== "C") throw new Error("MOC must be ICRS/NUNIQ");
      const rows = Number(header.get("NAXIS2")), stride = Number(header.get("NAXIS1"));
      const format = header.get("TFORM1");
      if (!['K', '1K', 'J', '1J'].includes(format ?? "") || !Number.isSafeInteger(rows) || rows < 1 || rows > 5_000_000 || !Number.isSafeInteger(stride) || stride < (format!.includes("K") ? 8 : 4) || start + rows * stride > bytes.length) throw new Error("Unsupported or truncated NUNIQ table");
      const cells: MocCell[] = [];
      for (let i = 0; i < rows; i++) {
        const uniq = format!.includes("K") ? bytes.readBigInt64BE(start + i * stride) : BigInt(bytes.readInt32BE(start + i * stride));
        if (uniq < 4n) throw new Error("Invalid NUNIQ cell");
        const order = Math.floor((uniq.toString(2).length - 3) / 2);
        const pixel = uniq - 4n * 4n ** BigInt(order);
        // The public query contract is bounded to O13, avoiding unsafe integers
        // and unbounded expansion. Reject unsupported source geometry explicitly.
        if (order > 13 || pixel < 0n || pixel >= 12n * 4n ** BigInt(order)) throw new Error("Unsupported MOC order (maximum O13)");
        cells.push({ order, pixel: Number(pixel) });
      }
      cells.sort((a, b) => a.order - b.order || a.pixel - b.pixel);
      const known = new Set<string>();
      for (const cell of cells) {
        for (let o = 0; o <= cell.order; o++) if (known.has(`${o}:${Math.floor(cell.pixel / 4 ** (cell.order - o))}`)) throw new Error("Overlapping or duplicate NUNIQ cells");
        known.add(`${cell.order}:${cell.pixel}`);
      }
      // Canonical identity uses merged O13 intervals, independent of cell packing.
      const ranges = cells.map(c => [c.pixel * 4 ** (13 - c.order), (c.pixel + 1) * 4 ** (13 - c.order)] as [number, number]).sort((a,b) => a[0] - b[0]);
      const merged: Array<[number, number]> = [];
      for (const range of ranges) {
        const previous = merged.at(-1);
        if (previous && previous[1] === range[0]) previous[1] = range[1]; else merged.push([...range]);
      }
      const availableOrders = [...new Set(cells.map(c => c.order))].sort((a,b) => a-b);
      return { cells, availableOrders, maxOrder: availableOrders.at(-1)!, revision: sha256(JSON.stringify({ coordinateFrame: "ICRS", ordering: "NESTED", intervalOrder: 13, ranges: merged })), sha256: sha256(bytes) };
    }
    let size = Number(header.get("PCOUNT") ?? 0);
    const axes = Number(header.get("NAXIS") ?? 0);
    if (axes) { let elements = 1; for (let i=1;i<=axes;i++) elements *= Number(header.get(`NAXIS${i}`)); size += elements * Math.abs(Number(header.get("BITPIX"))) / 8; }
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid FITS dimensions");
    offset = start + Math.ceil(size / 2880) * 2880;
  }
  throw new Error("Missing NUNIQ table");
}

/** Conservative projection; refinement represents an existing cell, not new evidence. */
export function projectMoc(moc: NativeMoc, order: number, region?: { order: number; cells: readonly number[] }, limit = 5_000_000): { cells: number[]; truncated: boolean } {
  if (!Number.isSafeInteger(order) || order < 0 || order > moc.maxOrder) throw new Error("Unsupported projection order");
  const intervals = region?.cells.map(pixel => region.order <= order
    ? [pixel * 4 ** (order-region.order), (pixel+1) * 4 ** (order-region.order)] as const
    : [Math.floor(pixel / 4 ** (region.order-order)), Math.floor(pixel / 4 ** (region.order-order))+1] as const).sort((a,b) => a[0]-b[0]);
  const ranges: Array<[number,number]> = [];
  for (const cell of moc.cells) {
    const scale = 4 ** Math.abs(order-cell.order);
    const low = cell.order <= order ? cell.pixel * scale : Math.floor(cell.pixel / scale);
    const high = cell.order <= order ? (cell.pixel+1)*scale : low+1;
    if (!intervals) ranges.push([low,high]);
    else {
      let lo=0, hi=intervals.length;
      while (lo<hi) { const mid=(lo+hi)>>>1; if (intervals[mid]![1]<=low) lo=mid+1; else hi=mid; }
      for (let i=lo;i<intervals.length && intervals[i]![0]<high;i++) {
        const interval=intervals[i]!;
        ranges.push([Math.max(low,interval[0]),Math.min(high,interval[1])]);
      }
    }
  }
  ranges.sort((a,b) => a[0]-b[0]);
  const result: number[] = []; let previous = -1;
  for (const [low,high] of ranges) for (let pixel=Math.max(low,previous+1);pixel<high;pixel++) {
    if (result.length >= limit) return { cells: result, truncated: true };
    result.push(pixel); previous = pixel;
  }
  return { cells: result, truncated: false };
}
