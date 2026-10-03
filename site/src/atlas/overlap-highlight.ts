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

const dashOffsetUniforms = new WeakMap<THREE.LineDashedMaterial, { value: number }>();

export function setOverlapHighlightFlowOffset(material: THREE.LineDashedMaterial, offset: number): void {
  const uniform = dashOffsetUniforms.get(material);
  if (!uniform) return;
  const period = material.dashSize + material.gapSize;
  uniform.value = period > 0 ? ((offset % period) + period) % period : 0;
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
  const dashOffset = { value: 0 };
  dashOffsetUniforms.set(dashMaterial, dashOffset);
  dashMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.overlapDashOffset = dashOffset;
    shader.uniforms.overlapFlowColor = { value: new THREE.Color("#fff1b8") };
    shader.fragmentShader = shader.fragmentShader
      .replace("uniform float totalSize;", "uniform float totalSize;\nuniform float overlapDashOffset;\nuniform vec3 overlapFlowColor;")
      .replace(
        "if ( mod( vLineDistance, totalSize ) > dashSize ) {",
        "float overlapDashDistance = mod(vLineDistance + overlapDashOffset, totalSize);\n\tif ( overlapDashDistance > dashSize ) {",
      )
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\n\tfloat overlapFlow = 0.5 + 0.5 * cos((vLineDistance + overlapDashOffset) * 10.0);\n\tdiffuseColor.rgb = mix(diffuseColor.rgb, overlapFlowColor, overlapFlow * 0.78);",
      );
  };
  dashMaterial.customProgramCacheKey = () => "overlap-highlight-flow-v1";
  const dashEdges = new THREE.LineSegments(edgeGeometry.clone(), dashMaterial);
  // computeLineDistances belongs to LineSegments, not BufferGeometry.
  dashEdges.computeLineDistances();
  dashEdges.renderOrder = renderOrder + 2;

  root.add(mesh, glowEdges, dashEdges);
  return { root, mesh, meshMaterial, glowEdges, glowMaterial, dashEdges, dashMaterial };
}
