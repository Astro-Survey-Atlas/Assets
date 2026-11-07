/** Home hero globe: the Atlas sky body seen close to its limb, so only a
 * corner of the sphere arcs through the hero. It draws real public O4
 * survey unions with the same HUD materials as the Atlas, and on "Open Sky
 * Atlas" pulls back to the Atlas framing before navigating there. */
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

import {
  applyCellRim,
  applyNeutralDepth,
  buildHudBackdrop,
  cellRimUniforms,
  fatLines,
  HudFinalShader,
  regionOutlinePositions,
  sceneTheme,
  type SceneTheme,
  buildSphericalCellEdges,
  buildSphericalCellSheetGeometry,
  surveyColorFor,
} from "@astro-survey-atlas/sky-globe";

export interface HomeGlobeLayer { surveyId: string; color?: string; nside: number; pixels: readonly number[] }

interface Pose { distance: number; centerX: number; centerY: number }

/* Hero framing: the camera sits just above the surface and the projection is
 * shifted so the sphere centre lies below-right of the canvas. */
const HERO_POSE: Pose = { distance: 2.9, centerX: 0.9, centerY: 1.1 };
/* Atlas framing: the whole sphere centred, as /atlas/ first shows it. */
const ATLAS_POSE: Pose = { distance: 6.5, centerX: 0.5, centerY: 0.5 };
const FOV = 22;

const themeName = (): "light" | "dark" => document.documentElement.dataset.theme === "light" ? "light" : "dark";
const reducedMotion = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const ease = (t: number): number => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

export class HomeGlobe {
  readonly #canvas: HTMLCanvasElement;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 30);
  readonly #composer: EffectComposer;
  readonly #bloom: UnrealBloomPass;
  readonly #final: ShaderPass;
  readonly #resolution = new THREE.Vector2(1, 1);
  readonly #tilt = new THREE.Group();
  /** Spins about its own y axis, which is the celestial pole. */
  readonly #spin = new THREE.Group();
  readonly #coverage = new THREE.Group();
  readonly #backdrop: ReturnType<typeof buildHudBackdrop>;
  #palette: SceneTheme;
  #layers: HomeGlobeLayer[] = [];
  #pose: Pose = { ...HERO_POSE };
  #frame = 0;
  /** Software rasterisers (SwiftShader, llvmpipe) get a still globe. */
  readonly #still: boolean;
  #visible = true;
  #last = 0;
  #flight: { from: Pose; start: number; duration: number; done: () => void } | null = null;
  readonly #observers: Array<{ disconnect(): void }> = [];

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.#renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    const gl = this.#renderer.getContext();
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const rendererName = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    this.#still = /swiftshader|llvmpipe|software/i.test(rendererName);
    this.#palette = sceneTheme(themeName());
    this.#composer = new EffectComposer(this.#renderer);
    this.#composer.addPass(new RenderPass(this.#scene, this.#camera));
    this.#bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0, 0.2, 0.6);
    this.#composer.addPass(this.#bloom);
    this.#final = new ShaderPass(HudFinalShader);
    this.#composer.addPass(this.#final);
    this.#composer.addPass(new OutputPass());

    this.#backdrop = buildHudBackdrop(this.#resolution, this.#palette);
    this.#spin.add(this.#backdrop.group, this.#coverage);
    // Tilt the celestial pole towards the viewer so the arc shows northern sky.
    this.#tilt.rotation.set(0.42, 0, 0.18);
    this.#spin.rotation.y = -2.3;
    this.#tilt.add(this.#spin);
    this.#scene.add(this.#tilt, this.#stars());
    this.#camera.position.set(0, 0, HERO_POSE.distance);
    this.#camera.lookAt(0, 0, 0);
    this.#applyTheme();

    const resize = new ResizeObserver(() => this.#resize());
    resize.observe(canvas);
    const visibility = new IntersectionObserver(([entry]) => { this.#visible = Boolean(entry?.isIntersecting); this.#loop(); });
    visibility.observe(canvas);
    const theme = new MutationObserver(() => this.#applyTheme());
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    this.#observers.push(resize, visibility, theme);
    document.addEventListener("visibilitychange", this.#loop);
    this.#resize();
    canvas.dataset.ready = "true";
  }

  setLayers(layers: HomeGlobeLayer[]): void {
    this.#layers = layers;
    this.#buildCoverage();
    this.#render();
  }

  /** Pull back from the limb to the Atlas framing, then resolve. */
  flyToAtlas(duration = 950): Promise<void> {
    if (reducedMotion()) return Promise.resolve();
    return new Promise((resolve) => {
      this.#flight = { from: { ...this.#pose }, start: performance.now(), duration, done: resolve };
      this.#loop();
    });
  }

  /** Back at the hero framing, e.g. after returning through the page cache. */
  reset(): void {
    this.#flight = null;
    this.#pose = { ...HERO_POSE };
    this.#applyPose();
    this.#render();
    this.#loop();
  }

  dispose(): void {
    cancelAnimationFrame(this.#frame);
    this.#observers.forEach((observer) => observer.disconnect());
    document.removeEventListener("visibilitychange", this.#loop);
    this.#backdrop.dispose();
    this.#renderer.dispose();
  }

  #stars(): THREE.Points {
    const count = 900;
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      const z = 1 - (2 * (index + 0.5)) / count;
      const radius = Math.sqrt(1 - z * z);
      const phi = index * Math.PI * (3 - Math.sqrt(5));
      positions.set([Math.cos(phi) * radius * 9, z * 9, Math.sin(phi) * radius * 9], index * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color: this.#palette.stars, size: 1.4, sizeAttenuation: false, transparent: true, opacity: this.#palette.starOpacity }));
    points.name = "home-stars";
    return points;
  }

  #applyTheme(): void {
    this.#palette = sceneTheme(themeName());
    const palette = this.#palette;
    cellRimUniforms.rimCore.value = palette.rimCore;
    cellRimUniforms.rimGain.value = palette.rimGain;
    cellRimUniforms.fillGain.value = palette.fillGain;
    cellRimUniforms.edgeGain.value = palette.edgeGain;
    cellRimUniforms.cellDetail.value = 1;
    cellRimUniforms.stackGain.value = palette.additiveCoverage ? 0.42 : 1;
    cellRimUniforms.limbFade.value = palette.additiveCoverage ? 1 : 0;
    this.#renderer.setClearColor(palette.background, 1);
    this.#backdrop.setTheme(palette);
    const stars = this.#scene.getObjectByName("home-stars") as THREE.Points | undefined;
    if (stars) {
      (stars.material as THREE.PointsMaterial).color.setHex(palette.stars);
      (stars.material as THREE.PointsMaterial).opacity = palette.starOpacity;
    }
    this.#bloom.enabled = palette.bloom.strength > 0;
    this.#bloom.strength = palette.bloom.strength * 0.5;
    this.#bloom.radius = palette.bloom.radius;
    this.#bloom.threshold = palette.bloom.threshold;
    this.#final.uniforms.vignette!.value = palette.final.vignette * 0.6;
    this.#final.uniforms.grain!.value = palette.final.grain;
    this.#final.uniforms.scanlines!.value = palette.final.scanlines;
    this.#buildCoverage();
    this.#render();
  }

  #buildCoverage(): void {
    for (const child of [...this.#coverage.children]) {
      this.#coverage.remove(child);
      child.traverse((node) => {
        const mesh = node as THREE.Mesh;
        mesh.geometry?.dispose();
        (mesh.material as THREE.Material | undefined)?.dispose();
      });
    }
    const palette = this.#palette;
    const additive = palette.additiveCoverage;
    const blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.#layers.forEach((layer, index) => {
      if (!layer.pixels.length) return;
      const color = new THREE.Color(surveyColorFor(layer.surveyId, layer.color));
      const radius = 1.004 + index * 0.004;
      const cells = layer.pixels.map((pixel) => ({ nside: layer.nside, pixel, radius, color, inset: 0.035 }));
      const fill = new THREE.Mesh(buildSphericalCellSheetGeometry(cells), applyCellRim(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: additive ? 0.5 : 0.34, side: THREE.DoubleSide, depthWrite: false, blending, toneMapped: false })));
      const edges = new THREE.LineSegments(buildSphericalCellEdges(cells), applyNeutralDepth(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: additive ? 0.5 : 0.5, depthWrite: false, blending, toneMapped: false })));
      fill.renderOrder = 2 + index;
      edges.renderOrder = 2 + index;
      this.#coverage.add(fill, edges);
      const outline = regionOutlinePositions(layer.nside, layer.pixels, radius + 0.0025);
      if (!outline.length) return;
      // Outlines crowd together at the limb; keep them thinner and dimmer than in the Atlas.
      if (palette.outlineGlowWidth > 0) this.#coverage.add(fatLines(outline, color, palette.outlineGlowWidth * 0.5, palette.outlineGlowOpacity * 0.5, this.#resolution, { additive: true, renderOrder: 20 }));
      this.#coverage.add(fatLines(outline, color, palette.outlineWidth * 0.8, additive ? 0.55 : 0.85, this.#resolution, { additive, renderOrder: 21 }));
    });
  }

  #resize(): void {
    const width = Math.max(1, Math.round(this.#canvas.clientWidth));
    const height = Math.max(1, Math.round(this.#canvas.clientHeight));
    this.#renderer.setSize(width, height, false);
    this.#composer.setSize(width, height);
    this.#bloom.setSize(width, height);
    this.#resolution.set(width, height);
    this.#final.uniforms.resolution!.value.set(width, height);
    this.#camera.aspect = width / height;
    this.#applyPose();
    this.#render();
  }

  /** Shift the lens so the sphere centre falls at (centerX, centerY) of the canvas. */
  #applyPose(): void {
    const width = this.#resolution.x;
    const height = this.#resolution.y;
    this.#camera.position.set(0, 0, this.#pose.distance);
    this.#camera.lookAt(0, 0, 0);
    this.#camera.setViewOffset(width, height, (0.5 - this.#pose.centerX) * width, (0.5 - this.#pose.centerY) * height, width, height);
    this.#camera.updateProjectionMatrix();
  }

  #render(): void {
    this.#composer.render();
  }

  readonly #loop = (): void => {
    cancelAnimationFrame(this.#frame);
    const animate = this.#flight != null || (!this.#still && !reducedMotion() && this.#visible && document.visibilityState === "visible");
    if (!animate) return;
    this.#frame = requestAnimationFrame((now) => {
      const delta = this.#last ? Math.min(0.05, (now - this.#last) / 1000) : 0;
      this.#last = now;
      if (!this.#still && !reducedMotion()) this.#spin.rotation.y += delta * 0.035;
      const flight = this.#flight;
      if (flight) {
        const t = Math.min(1, (now - flight.start) / flight.duration);
        const k = ease(t);
        this.#pose = {
          distance: flight.from.distance + (ATLAS_POSE.distance - flight.from.distance) * k,
          centerX: flight.from.centerX + (ATLAS_POSE.centerX - flight.from.centerX) * k,
          centerY: flight.from.centerY + (ATLAS_POSE.centerY - flight.from.centerY) * k,
        };
        this.#applyPose();
        if (t >= 1) {
          this.#flight = null;
          flight.done();
        }
      }
      this.#render();
      this.#loop();
    });
  };
}
