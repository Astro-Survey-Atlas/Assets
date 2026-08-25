export type LayerOrderLayout = "overlap" | "layers";

export interface LayerDepth {
  key: string;
  radius: number;
  renderOrder: number;
}

// Overlap mode is a true co-registered view: every survey surface is drawn on
// the same unit sphere. Render order (rather than radial separation) keeps the
// transparent meshes deterministic and leaves the intersection highlighter
// visible above them.
const OVERLAP_DEPTH_STEP = 0;
// Keep the public survey surfaces visibly separated in the hero composition.
// Overlap mode still collapses these surfaces back onto one sphere.
const RADIAL_DEPTH_STEP = 0.12;

export function normalizeLayerOrder(
  knownKeys: Iterable<string>,
  storedKeys: Iterable<string> = [],
  defaultKeys: Iterable<string> = [],
): string[] {
  const known = new Set(knownKeys);
  const ordered: string[] = [];
  const add = (key: string): void => {
    if (known.has(key) && !ordered.includes(key)) ordered.push(key);
  };
  for (const key of storedKeys) add(key);
  for (const key of defaultKeys) add(key);
  // Only add all known keys if defaultKeys was provided and non-empty
  const defaults = Array.isArray(defaultKeys) ? defaultKeys : [...defaultKeys];
  if (defaults.length > 0) {
    for (const key of known) add(key);
  }
  return ordered;
}

export function visibleLayerDepths(
  order: readonly string[],
  visibleKeys: Iterable<string>,
  layout: LayerOrderLayout,
): LayerDepth[] {
  const visible = new Set(visibleKeys);
  const keys = order.filter((key) => visible.has(key));
  const midpoint = (keys.length - 1) / 2;
  const step = layout === "layers" ? RADIAL_DEPTH_STEP : OVERLAP_DEPTH_STEP;
  return keys.map((key, index) => ({
    key,
    // The first list item is the front-most layer.
    radius: 1 + (midpoint - index) * step,
    renderOrder: 2 + (keys.length - 1 - index) * 2,
  }));
}
