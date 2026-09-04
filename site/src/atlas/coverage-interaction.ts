export type CoverageEscapeIntent = "dismiss-overlap-drawer" | "clear-focus" | "reset-experience";

export interface CoverageEscapeState {
  overlapDrawerOpen: boolean;
  now: number;
  lastEscapeAt: number;
  doubleEscapeWindowMs?: number;
}

/** Preserve the established two-step Escape flow while making its scope explicit. */
export function coverageEscapeIntent(state: CoverageEscapeState): CoverageEscapeIntent {
  if (state.overlapDrawerOpen) return "dismiss-overlap-drawer";
  const windowMs = state.doubleEscapeWindowMs ?? 500;
  return state.now - state.lastEscapeAt < windowMs ? "reset-experience" : "clear-focus";
}
