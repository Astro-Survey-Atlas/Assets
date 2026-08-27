/**
 * Decide whether the expanded overlap drawer leaves too little room for the
 * sky and the two auxiliary coverage panels. The sky gets a generous share
 * of the viewport on dense desktop layouts; very wide screens can keep the
 * existing panels visible alongside the drawer.
 */
export function overlapPanelsShouldExit(viewportWidth: number, drawerWidth: number, requiredSkyWidth = Math.max(960, viewportWidth * 0.72)): boolean {
  if (!Number.isFinite(viewportWidth) || !Number.isFinite(drawerWidth)) return true;
  if (viewportWidth <= 0 || drawerWidth <= 0) return false;
  return viewportWidth - Math.min(viewportWidth, drawerWidth) < requiredSkyWidth;
}

export function overlapPanelExitTransform(viewportWidth: number): string {
  const distance = Math.max(48, Math.ceil(viewportWidth) + 48);
  return `translateX(-${distance}px)`;
}
