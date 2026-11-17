/**
 * Shareable atlas view: the globe camera pose carried in the URL as `view=`.
 *
 * Ten numbers, comma separated: position(3) target(3) up(3) fov. The pose is the
 * viewer's own `cameraPose`, so restoring it reproduces the exact view. Anything
 * that does not parse or is outside the viewer's sane limits is ignored rather
 * than clamped, so a damaged link opens the normal home view.
 */
export interface ViewPose {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
}

export const VIEW_PARAM = "view";

// Limits mirror the viewer: OrbitControls distance 0.002..7.5, perspective fov in degrees.
const MAX_DISTANCE = 7.5;
const MIN_FOV = 0.05;
const MAX_FOV = 120;
const PRECISION = 5;

const length = (v: readonly number[]): number => Math.hypot(v[0]!, v[1]!, v[2]!);

export function encodeViewPose(pose: ViewPose): string {
  return [...pose.position, ...pose.target, ...pose.up, pose.fov]
    .map((value) => Number(value.toFixed(PRECISION)).toString())
    .join(",");
}

export function decodeViewPose(text: string | null | undefined): ViewPose | null {
  if (!text || text.length > 200) return null;
  const parts = text.split(",");
  if (parts.length !== 10) return null;
  const numbers = parts.map((part) => (/^-?\d+(\.\d+)?$/.test(part) ? Number(part) : Number.NaN));
  if (numbers.some((value) => !Number.isFinite(value))) return null;
  const position = numbers.slice(0, 3) as [number, number, number];
  const target = numbers.slice(3, 6) as [number, number, number];
  const up = numbers.slice(6, 9) as [number, number, number];
  const fov = numbers[9]!;
  if (fov < MIN_FOV || fov > MAX_FOV) return null;
  if (length(position) > MAX_DISTANCE * 2 || length(target) > MAX_DISTANCE) return null;
  if (length(up) < 0.5 || length(up) > 1.5) return null;
  const offset = [position[0] - target[0], position[1] - target[1], position[2] - target[2]];
  const distance = length(offset);
  if (distance < 0.001 || distance > MAX_DISTANCE) return null;
  return { position, target, up, fov };
}

/** Current URL with the view applied, keeping every other query parameter. */
export function withViewParam(href: string, pose: ViewPose | null): string {
  const url = new URL(href);
  if (pose) url.searchParams.set(VIEW_PARAM, encodeViewPose(pose));
  else url.searchParams.delete(VIEW_PARAM);
  return url.toString();
}
