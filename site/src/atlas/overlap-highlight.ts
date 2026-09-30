import * as THREE from "three";

import {
  buildSphericalCellEdges,
  buildSphericalCellSheetGeometry,
  type SphericalCellSheetGeometryInput,
} from "./spherical-cell-geometry.js";

export interface OverlapHighlight {
  root: THREE.Group;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  meshMaterial: THREE.MeshBasicMaterial;
  glowEdges: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  glowMaterial: THREE.LineBasicMaterial;
  dashEdges: THREE.LineSegments<THREE.BufferGeometry, THREE.LineDashedMaterial>;
  dashMaterial: THREE.LineDashedMaterial;
}

/** Build one co-registered overlap surface with an always-readable animated edge. */
export function buildOverlapHighlight(
  cells: readonly SphericalCellSheetGeometryInput[],
  renderOrder: number,
  opacity = 0.9,
): OverlapHighlight {
  const root = new THREE.Group();
  const meshMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(buildSphericalCellSheetGeometry(cells), meshMaterial);
  mesh.renderOrder = renderOrder;

  const edgeGeometry = buildSphericalCellEdges(cells);
  const glowMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.58,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const glowEdges = new THREE.LineSegments(edgeGeometry, glowMaterial);
  glowEdges.renderOrder = renderOrder + 1;

  const dashMaterial = new THREE.LineDashedMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 1,
    dashSize: 0.04,
    gapSize: 0.022,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const dashEdges = new THREE.LineSegments(edgeGeometry.clone(), dashMaterial);
  // computeLineDistances belongs to LineSegments, not BufferGeometry.
  dashEdges.computeLineDistances();
  dashEdges.renderOrder = renderOrder + 2;

  root.add(mesh, glowEdges, dashEdges);
  return { root, mesh, meshMaterial, glowEdges, glowMaterial, dashEdges, dashMaterial };
}
