import * as THREE from "three";
import { Healpix } from "healpixjs";

export interface CoverageFootprint {
  surveyId: string;
  releaseId: string;
  product: string;
  label?: string;
  nside: number;
  pixels: number[];
  quality?: string;
  sourceUrl?: string;
  notes?: string;
}

export interface CoverageManifest {
  schemaVersion: number;
  generatedAt: string;
  coordinateFrame: string;
  nside: number;
  footprints: CoverageFootprint[];
}

const SURVEY_COLORS: Record<string, number> = {
  euclid: 0x55ecd0,
  galex: 0x7db4ff,
  "legacy-surveys": 0xf6c35b,
  sdss: 0xdc79ff,
  "hsc-ssp": 0x61de8a,
  hst: 0xff846f,
  panstarrs: 0x70cdee,
  des: 0xf8a448,
  "2mass": 0xba9bff,
  allwise: 0xfadd63,
  kids: 0x5ad2c2,
  nvss: 0xff91be,
};

function colorForSurvey(surveyId: string): THREE.Color {
  return new THREE.Color(SURVEY_COLORS[surveyId] ?? 0x9cbcc6);
}

function sceneVector(vector: { x: number; y: number; z: number }, radius: number): THREE.Vector3 {
  return new THREE.Vector3(-vector.y * radius, vector.z * radius, -vector.x * radius);
}

function insetBoundary(boundary: THREE.Vector3[], radius: number, inset: number): THREE.Vector3[] {
  const center = boundary.reduce((sum, point) => sum.add(point), new THREE.Vector3()).normalize();
  return boundary.map((point) => point.clone().normalize().lerp(center, inset).normalize().multiplyScalar(radius));
}

function footprintGeometry(healpix: Healpix, pixels: readonly number[], radius: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const triangles = [[0, 1, 2], [0, 2, 3]] as const;
  for (const pixel of pixels) {
    const boundary = insetBoundary(healpix.getBoundaries(pixel).map((vector) => sceneVector(vector, radius)), radius, 0.035);
    if (boundary.length !== 4) continue;
    for (const triangle of triangles) {
      for (const index of triangle) {
        const vertex = boundary[index]!;
        positions.push(vertex.x, vertex.y, vertex.z);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function dispose(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.LineSegments)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material.dispose());
  });
}

export class CoverageSphere {
  readonly #canvas: HTMLCanvasElement;
  readonly #host: HTMLElement;
  readonly #tooltip: HTMLElement;
  readonly #fallback: HTMLImageElement;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(30, 1, 0.1, 10);
  readonly #root = new THREE.Group();
  readonly #raycaster = new THREE.Raycaster();
  readonly #pointer = new THREE.Vector2();
  readonly #resizeObserver: ResizeObserver;
  #dragging = false;
  #moved = false;
  #lastPointer = { x: 0, y: 0 };
  #animation = 0;
  #hovered: CoverageFootprint | null = null;

  constructor(host: HTMLElement, canvas: HTMLCanvasElement, tooltip: HTMLElement, fallback: HTMLImageElement) {
    this.#host = host;
    this.#canvas = canvas;
    this.#tooltip = tooltip;
    this.#fallback = fallback;
    this.#renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#renderer.setClearColor(0x000000, 0);
    this.#camera.position.set(0, 0, 3.15);
    this.#camera.lookAt(0, 0, 0);
    this.#scene.add(this.#root);
    this.#bind();
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(host);
    this.#resize();
  }

  load(manifest: CoverageManifest): void {
    dispose(this.#root);
    this.#root.clear();
    const healpix = new Healpix(manifest.nside);
    const guide = new THREE.Mesh(
      new THREE.SphereGeometry(0.997, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0x152126, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false }),
    );
    const grid = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(1, 24, 16)), new THREE.LineBasicMaterial({ color: 0x5f848b, transparent: true, opacity: 0.18 }));
    this.#root.add(guide, grid);

    manifest.footprints.forEach((footprint, index) => {
      if (!footprint.pixels.length) return;
      const geometry = footprintGeometry(healpix, footprint.pixels, 1.006 + index * 0.00015);
      const cells = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: colorForSurvey(footprint.surveyId),
        transparent: true,
        opacity: 0.34,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
      }));
      cells.userData.footprint = footprint;
      cells.renderOrder = index + 1;
      this.#root.add(cells);
    });
    this.#fallback.hidden = true;
    this.#canvas.dataset.ready = "true";
    this.#animate();
  }

  showError(): void {
    this.#canvas.hidden = true;
    this.#fallback.hidden = false;
  }

  dispose(): void {
    cancelAnimationFrame(this.#animation);
    this.#resizeObserver.disconnect();
    dispose(this.#root);
    this.#renderer.dispose();
  }

  #bind(): void {
    this.#canvas.addEventListener("pointerdown", (event) => {
      this.#dragging = true;
      this.#moved = false;
      this.#lastPointer = { x: event.clientX, y: event.clientY };
      this.#canvas.setPointerCapture(event.pointerId);
    });
    this.#canvas.addEventListener("pointermove", (event) => {
      if (this.#dragging) {
        const dx = event.clientX - this.#lastPointer.x;
        const dy = event.clientY - this.#lastPointer.y;
        this.#moved ||= Math.abs(dx) + Math.abs(dy) > 2;
        this.#root.rotation.y += dx * 0.006;
        this.#root.rotation.x = Math.max(-0.75, Math.min(0.75, this.#root.rotation.x + dy * 0.004));
        this.#lastPointer = { x: event.clientX, y: event.clientY };
        return;
      }
      this.#pick(event);
    });
    this.#canvas.addEventListener("pointerup", (event) => {
      this.#dragging = false;
      this.#canvas.releasePointerCapture(event.pointerId);
      if (!this.#moved) this.#pick(event, true);
    });
    this.#canvas.addEventListener("pointerleave", () => {
      if (!this.#dragging) this.#hideTooltip();
    });
  }

  #pick(event: PointerEvent, persistent = false): void {
    const bounds = this.#canvas.getBoundingClientRect();
    this.#pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    this.#pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    const hit = this.#raycaster.intersectObjects(this.#root.children, false).find((entry) => entry.object.userData.footprint) as THREE.Intersection<THREE.Mesh> | undefined;
    const footprint = hit?.object.userData.footprint as CoverageFootprint | undefined;
    if (!footprint) {
      if (!persistent) this.#hideTooltip();
      return;
    }
    this.#hovered = footprint;
    this.#renderTooltip(footprint, event.clientX, event.clientY);
  }

  #renderTooltip(footprint: CoverageFootprint, x: number, y: number): void {
    this.#tooltip.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = footprint.label ?? footprint.product;
    const meta = document.createElement("span");
    meta.textContent = `${footprint.surveyId.toUpperCase()} / ${footprint.releaseId} / ${footprint.pixels.length} CELLS`;
    this.#tooltip.append(title, meta);
    if (footprint.notes) {
      const notes = document.createElement("small");
      notes.textContent = footprint.notes;
      this.#tooltip.append(notes);
    }
    if (footprint.sourceUrl) {
      const source = document.createElement("a");
      source.href = footprint.sourceUrl;
      source.target = "_blank";
      source.rel = "noreferrer";
      source.textContent = "查看来源";
      this.#tooltip.append(source);
    }
    const hostBounds = this.#host.getBoundingClientRect();
    this.#tooltip.style.left = `${Math.max(12, Math.min(x - hostBounds.left + 14, hostBounds.width - 280))}px`;
    this.#tooltip.style.top = `${Math.max(12, Math.min(y - hostBounds.top + 14, hostBounds.height - 130))}px`;
    this.#tooltip.hidden = false;
  }

  #hideTooltip(): void {
    this.#hovered = null;
    this.#tooltip.hidden = true;
  }

  #resize(): void {
    const bounds = this.#host.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    this.#renderer.setSize(width, height, false);
    this.#camera.aspect = width / height;
    this.#camera.updateProjectionMatrix();
  }

  #animate(): void {
    this.#animation = requestAnimationFrame(() => this.#animate());
    this.#root.rotation.y += 0.0007;
    this.#renderer.render(this.#scene, this.#camera);
  }
}
