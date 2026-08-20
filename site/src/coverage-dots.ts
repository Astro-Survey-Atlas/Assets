import { Healpix } from "healpixjs";

export interface CoverageFootprint {
  surveyId: string;
  releaseId: string;
  product: string;
  label?: string;
  nside: number;
  pixels: number[];
}

export interface CoverageManifest {
  schemaVersion: number;
  generatedAt: string;
  coordinateFrame: string;
  nside: number;
  footprints: CoverageFootprint[];
}

interface Dot {
  pixel: number;
  surveys: Set<string>;
  x: number;
  y: number;
  depth: number;
}

const AMBER = "#f4a62a";
const AMBER_PALE = "#ffd47a";
const FRAME = "rgba(230, 148, 31, 0.54)";

function seeded(index: number, salt: number): number {
  const value = Math.sin(index * 91.731 + salt * 17.137) * 43758.5453;
  return value - Math.floor(value);
}

function parseColor(value: string | undefined): string {
  return /^#[\da-f]{6}$/i.test(value ?? "") ? value! : AMBER_PALE;
}

export class CoverageDots {
  readonly #host: HTMLElement;
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #resizeObserver: ResizeObserver;
  #healpix: Healpix | null = null;
  #dots: Dot[] = [];
  #surveyColors = new Map<string, string>();
  #highlightedSurvey: string | null = null;
  #frame = 0;

  constructor(host: HTMLElement, canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("2D canvas is unavailable");
    this.#host = host;
    this.#canvas = canvas;
    this.#context = context;
    this.#resizeObserver = new ResizeObserver(() => this.#scheduleDraw());
    this.#resizeObserver.observe(host);
    this.#scheduleDraw();
  }

  load(manifest: CoverageManifest, surveyColors: ReadonlyMap<string, string>): void {
    this.#healpix = new Healpix(manifest.nside);
    this.#surveyColors = new Map(surveyColors);
    const byPixel = new Map<number, Set<string>>();
    for (const footprint of manifest.footprints) {
      for (const pixel of footprint.pixels) {
        const surveys = byPixel.get(pixel) ?? new Set<string>();
        surveys.add(footprint.surveyId);
        byPixel.set(pixel, surveys);
      }
    }
    this.#dots = [...byPixel].map(([pixel, surveys]) => ({ pixel, surveys, x: 0, y: 0, depth: 0 }));
    this.#canvas.dataset.ready = "true";
    this.#scheduleDraw();
  }

  setHighlightedSurvey(surveyId: string | null): void {
    if (surveyId === this.#highlightedSurvey) return;
    this.#highlightedSurvey = surveyId;
    this.#host.dataset.highlightedSurvey = surveyId ?? "";
    this.#scheduleDraw();
  }

  dispose(): void {
    this.#resizeObserver.disconnect();
    if (this.#frame) cancelAnimationFrame(this.#frame);
  }

  #scheduleDraw(): void {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#draw();
    });
  }

  #draw(): void {
    const bounds = this.#host.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const canvasWidth = Math.round(width * dpr);
    const canvasHeight = Math.round(height * dpr);
    if (this.#canvas.width !== canvasWidth || this.#canvas.height !== canvasHeight) {
      this.#canvas.width = canvasWidth;
      this.#canvas.height = canvasHeight;
    }

    const context = this.#context;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = "#030303";
    context.fillRect(0, 0, width, height);
    this.#drawStars(context, width, height);
    this.#drawOrbit(context, width, height);
    this.#drawCoverage(context, width, height);
    this.#drawFrame(context, width, height);
  }

  #drawStars(context: CanvasRenderingContext2D, width: number, height: number): void {
    const count = Math.min(520, Math.round(width * height / 1800));
    for (let index = 0; index < count; index += 1) {
      const x = seeded(index, 1) * width;
      const y = 24 + seeded(index, 2) * height * 0.73;
      const radius = 0.45 + seeded(index, 3) * 1.25;
      const warm = seeded(index, 4) > 0.78;
      context.globalAlpha = 0.2 + seeded(index, 5) * 0.64;
      context.fillStyle = warm ? AMBER_PALE : "#e6ece9";
      context.fillRect(Math.round(x), Math.round(y), radius, radius);
    }
    context.globalAlpha = 1;
  }

  #drawOrbit(context: CanvasRenderingContext2D, width: number, height: number): void {
    const centerX = width * 0.76;
    const centerY = height * 1.03;
    const orbitWidth = Math.max(width * 0.48, 560);
    const orbitHeight = Math.max(height * 0.82, 390);

    context.save();
    context.strokeStyle = "rgba(206, 73, 31, 0.38)";
    context.lineWidth = 1;
    context.shadowColor = "rgba(218, 75, 29, 0.46)";
    context.shadowBlur = 8;
    for (let ring = 0; ring < 3; ring += 1) {
      context.beginPath();
      context.ellipse(centerX, centerY, orbitWidth + ring * 72, orbitHeight + ring * 62, -0.16, Math.PI * 1.08, Math.PI * 1.92);
      context.stroke();
    }
    context.shadowBlur = 0;

    for (let index = 0; index < 420; index += 1) {
      const angle = Math.PI * (1.08 + seeded(index, 7) * 0.84);
      const ring = Math.floor(seeded(index, 8) * 3);
      const spread = (seeded(index, 9) - 0.5) * 42;
      const radiusX = orbitWidth + ring * 72 + spread;
      const radiusY = orbitHeight + ring * 62 + spread * 0.5;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const rotation = -0.16;
      const x = centerX + radiusX * cos * Math.cos(rotation) - radiusY * sin * Math.sin(rotation);
      const y = centerY + radiusX * cos * Math.sin(rotation) + radiusY * sin * Math.cos(rotation);
      context.globalAlpha = 0.18 + seeded(index, 10) * 0.68;
      context.fillStyle = seeded(index, 11) > 0.65 ? AMBER : "#f4e7ce";
      const size = seeded(index, 12) > 0.92 ? 2 : 1;
      context.fillRect(Math.round(x), Math.round(y), size, size);
    }
    context.restore();
    context.globalAlpha = 1;
  }

  #drawCoverage(context: CanvasRenderingContext2D, width: number, height: number): void {
    if (!this.#healpix || !this.#dots.length) return;
    const mobile = width < 700;
    const radius = mobile ? Math.min(width * 0.9, height * 0.69) : Math.min(width * 0.44, height * 0.92);
    const centerX = mobile ? width * 0.72 : width * 0.79;
    const centerY = mobile ? height * 1.02 : height * 1.04;
    const yaw = -0.68;
    const pitch = -0.16;

    context.save();
    context.beginPath();
    context.arc(centerX, centerY, radius, Math.PI * 1.04, Math.PI * 1.96);
    context.lineWidth = 1.2;
    context.strokeStyle = "rgba(244, 166, 42, 0.58)";
    context.shadowColor = "rgba(244, 139, 22, 0.52)";
    context.shadowBlur = 12;
    context.stroke();
    context.shadowBlur = 0;

    for (const dot of this.#dots) {
      const point = this.#healpix.pix2ang(dot.pixel);
      const sinTheta = Math.sin(point.theta);
      const sourceX = sinTheta * Math.cos(point.phi);
      const sourceY = Math.cos(point.theta);
      const sourceZ = sinTheta * Math.sin(point.phi);
      const rotatedX = sourceX * Math.cos(yaw) + sourceZ * Math.sin(yaw);
      const firstDepth = -sourceX * Math.sin(yaw) + sourceZ * Math.cos(yaw);
      const rotatedY = sourceY * Math.cos(pitch) - firstDepth * Math.sin(pitch);
      const depth = sourceY * Math.sin(pitch) + firstDepth * Math.cos(pitch);
      dot.x = centerX + rotatedX * radius;
      dot.y = centerY - rotatedY * radius;
      dot.depth = depth;
    }

    const visible = this.#dots.filter((dot) => dot.depth > 0 && dot.y > 12 && dot.y < height + 3).sort((left, right) => left.depth - right.depth);
    const highlighted = this.#highlightedSurvey;
    for (const dot of visible) {
      const matches = highlighted ? dot.surveys.has(highlighted) : false;
      context.globalAlpha = highlighted ? (matches ? 0.98 : 0.12) : Math.min(0.88, 0.28 + dot.surveys.size * 0.075 + dot.depth * 0.2);
      context.fillStyle = matches ? parseColor(this.#surveyColors.get(highlighted!)) : (dot.depth > 0.72 ? AMBER_PALE : AMBER);
      const size = matches ? 3 : (dot.depth > 0.78 ? 2 : 1.35);
      context.beginPath();
      context.arc(dot.x, dot.y, size, 0, Math.PI * 2);
      context.fill();
    }

    if (highlighted) {
      context.globalAlpha = 0.86;
      context.strokeStyle = parseColor(this.#surveyColors.get(highlighted));
      context.lineWidth = 0.7;
      for (const dot of visible) {
        if (!dot.surveys.has(highlighted) || seeded(dot.pixel, 15) < 0.84) continue;
        const peer = visible[Math.floor(seeded(dot.pixel, 16) * visible.length)];
        if (!peer?.surveys.has(highlighted)) continue;
        context.beginPath();
        context.moveTo(dot.x, dot.y);
        context.lineTo(peer.x, peer.y);
        context.stroke();
      }
    }
    context.restore();
    context.globalAlpha = 1;
  }

  #drawFrame(context: CanvasRenderingContext2D, width: number, height: number): void {
    const inset = width < 560 ? 12 : 22;
    const top = inset;
    const bottom = height - inset;
    context.save();
    context.strokeStyle = FRAME;
    context.fillStyle = AMBER;
    context.lineWidth = 1;

    context.strokeRect(inset + 7, top + 7, width - (inset + 7) * 2, height - (inset + 7) * 2);
    const corner = width < 560 ? 22 : 38;
    for (const [x, y, sx, sy] of [[inset, top, 1, 1], [width - inset, top, -1, 1], [inset, bottom, 1, -1], [width - inset, bottom, -1, -1]] as const) {
      context.beginPath();
      context.moveTo(x, y + sy * corner);
      context.lineTo(x, y);
      context.lineTo(x + sx * corner, y);
      context.stroke();
    }

    const usableWidth = width - inset * 2;
    for (let index = 1; index < 24; index += 1) {
      const x = inset + usableWidth * index / 24;
      const long = index % 4 === 0;
      context.globalAlpha = long ? 0.7 : 0.28;
      context.fillRect(Math.round(x), top, 1, long ? 9 : 5);
      context.fillRect(Math.round(x), bottom - (long ? 9 : 5), 1, long ? 9 : 5);
    }
    context.globalAlpha = 0.74;
    context.font = "700 9px ui-monospace, SFMono-Regular, Consolas, monospace";
    context.fillText("ICRS / NESTED", inset + 16, top + 24);
    context.textAlign = "right";
    context.fillText(this.#highlightedSurvey ? this.#highlightedSurvey.toUpperCase() : "ALL PUBLIC SURVEYS", width - inset - 16, top + 24);
    context.restore();
  }
}
