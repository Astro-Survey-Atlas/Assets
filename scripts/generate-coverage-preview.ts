import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Healpix } from "healpixjs";
import { PNG } from "pngjs";

const root = path.resolve(process.env.ASSET_WORKTREE_ROOT ?? process.cwd());
const publicRoot = path.join(root, "site", "public");
const source = JSON.parse(await readFile(path.join(root, "src", "footprints", "survey-footprints.json"), "utf8")) as {
  nside: number;
  footprints: Array<{ surveyId: string; pixels: number[] }>;
};
const catalog = JSON.parse(await readFile(path.join(root, "src", "surveys", "survey-catalog.json"), "utf8")) as {
  surveys: Array<{ id: string; color: string }>;
};

type RGB = [number, number, number];
const healpix = new Healpix(source.nside);

function rgb(hex: string): RGB {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function render(width: number, height: number, surveys: Array<{ id: string; color: RGB }>): PNG {
  const image = new PNG({ width, height });
  const setPixel = (x: number, y: number, color: RGB, alpha = 1): void => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = (Math.floor(y) * width + Math.floor(x)) * 4;
    image.data[offset] = Math.round((image.data[offset] ?? 0) * (1 - alpha) + color[0] * alpha);
    image.data[offset + 1] = Math.round((image.data[offset + 1] ?? 0) * (1 - alpha) + color[1] * alpha);
    image.data[offset + 2] = Math.round((image.data[offset + 2] ?? 0) * (1 - alpha) + color[2] * alpha);
    image.data[offset + 3] = 255;
  };

  for (let y = 0; y < height; y += 1) {
    const latitude = 90 - (y / height) * 180;
    const shade = Math.round(8 + 7 * Math.cos(latitude * Math.PI / 180) ** 2);
    for (let x = 0; x < width; x += 1) setPixel(x, y, [shade, shade + 6, shade + 9]);
  }
  for (let longitude = 0; longitude <= 360; longitude += 30) {
    const x = Math.round(width * longitude / 360);
    for (let y = 0; y < height; y += 1) setPixel(x, y, [65, 91, 98], 0.42);
  }
  for (let latitude = -60; latitude <= 60; latitude += 30) {
    const y = Math.round(height * (90 - latitude) / 180);
    for (let x = 0; x < width; x += 1) setPixel(x, y, [65, 91, 98], latitude === 0 ? 0.58 : 0.34);
  }

  for (const survey of surveys) {
    const pixels = new Set(source.footprints.filter((footprint) => footprint.surveyId === survey.id).flatMap((footprint) => footprint.pixels));
    const radius = Math.max(2, Math.round(width / 280));
    for (const pixel of pixels) {
      const point = healpix.pix2ang(pixel);
      const x = Math.round(width * (1 - point.phi / (Math.PI * 2)));
      const y = Math.round(height * point.theta / Math.PI);
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (dx * dx + dy * dy > radius * radius) continue;
          setPixel((x + dx + width) % width, y + dy, survey.color, 0.48);
        }
      }
      setPixel(x, y, survey.color, 0.96);
    }
  }
  return image;
}

await mkdir(path.join(publicRoot, "surveys"), { recursive: true });
const surveys = catalog.surveys.map((survey) => ({ id: survey.id, color: rgb(survey.color) }));
await writeFile(path.join(publicRoot, "coverage-overview.png"), PNG.sync.write(render(1600, 720, surveys)));
for (const survey of surveys) {
  await writeFile(path.join(publicRoot, "surveys", `${survey.id}.png`), PNG.sync.write(render(800, 360, [survey])));
}
console.log(`Generated coverage overview and ${surveys.length} survey previews from ${source.footprints.length} real footprint records`);
