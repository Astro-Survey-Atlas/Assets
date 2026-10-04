import { createHash } from "node:crypto";

export interface EroFitsHeader {
  targetId: string; packageUrl: string; memberName: string; instrument: "VIS" | "NISP";
  filter: string; tarOffset: number; tarHeaderBase64: string;
  header: string; headerSha256: string; compressedPrefixBytes: number;
}
export interface EroFrameFootprint {
  kind: "fits-wcs-frame"; instrument: "VIS" | "NISP"; filter: string;
  sRegion: string; sourceUrl: string; memberName: string; sha256: string;
}

const sha = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const failure = (): never => { throw new Error("Invalid ERO FITS-header metadata or unsupported ICRS TAN WCS"); };

/** A bounded header is evidence for the image frame, not a valid-pixel mask. */
export function eroFitsFrame(input: EroFitsHeader): EroFrameFootprint {
  if (!input || !["VIS", "NISP"].includes(input.instrument)
    || !Number.isSafeInteger(input.tarOffset) || input.tarOffset < 0 || input.tarOffset % 512 !== 0
    || !Number.isSafeInteger(input.compressedPrefixBytes) || input.compressedPrefixBytes < 1 || input.compressedPrefixBytes > 65536
    || typeof input.header !== "string" || input.header.length < 2880 || input.header.length > 256 * 1024
    || input.header.length % 2880 !== 0 || /[^\x20-\x7e]/.test(input.header) || sha(input.header) !== input.headerSha256
    || typeof input.tarHeaderBase64 !== "string") failure();
  const tar = Buffer.from(input.tarHeaderBase64, "base64");
  if (tar.length !== 512 || ![0, 48].includes(tar[156]!)) failure();
  const text = (start: number, end: number): string => tar.subarray(start, end).toString("ascii").split("\0")[0]!.trim();
  const checksum = text(148, 156), size = text(124, 136);
  if (!/^[0-7]+$/.test(checksum) || !/^[0-7]+$/.test(size)) failure();
  const sum = tar.reduce((value, byte, index) => value + (index >= 148 && index < 156 ? 32 : byte), 0);
  const prefix = text(345, 500);
  const name = [prefix, text(0, 100)].filter(Boolean).join("/");
  if (sum !== Number.parseInt(checksum, 8) || name !== input.memberName
    || input.compressedPrefixBytes > Number.parseInt(size, 8)) failure();
  const escapedTarget = input.targetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const identity = new RegExp(`^${escapedTarget}/Euclid-(VIS|NISP-(Y|J|H|Chi2))-${escapedTarget}-Flattened\\.DR3\\.fits(?:\\.gz)?$`, "i").exec(name);
  const instrument = identity?.[1]?.toUpperCase() === "VIS" ? "VIS" : "NISP";
  const filter = instrument === "VIS" ? "VIS" : identity?.[2]?.toUpperCase();
  if (!identity || instrument !== input.instrument || filter !== input.filter
    || input.packageUrl !== `https://cdn.euclid.esac.esa.int/Stack/Euclid-${instrument}-Stack-${input.targetId}.DR3.tar`) failure();

  const cards = new Map<string, string>(); let end = -1;
  for (let offset = 0; offset < input.header.length; offset += 80) {
    const card = input.header.slice(offset, offset + 80), key = card.slice(0, 8).trim();
    if (key === "END") { end = offset + 80; break; }
    if (card.slice(8, 10) !== "= ") continue;
    if (cards.has(key)) failure();
    const raw = card.slice(10).trim();
    const quoted = /^'((?:[^']|'')*)'/.exec(raw);
    cards.set(key, quoted ? quoted[1]!.replaceAll("''", "'").trim() : raw.split("/")[0]!.trim());
  }
  if (end < 0 || Math.ceil(end / 2880) * 2880 !== input.header.length || input.header.slice(end).trim()
    || cards.get("SIMPLE") !== "T" || cards.get("NAXIS") !== "2" || cards.get("RADESYS") !== "ICRS"
    || cards.get("CTYPE1") !== "RA---TAN" || cards.get("CTYPE2") !== "DEC--TAN"
    || cards.get("CUNIT1") !== "deg" || cards.get("CUNIT2") !== "deg"
    || [...cards.keys()].some(key => /^(?:PV\d|PS\d|[AB]_|[AB]P_|CPDIS|D2IM|DP\d|DQ\d)/.test(key))) failure();
  const number = (key: string): number => {
    const raw = cards.get(key);
    if (!raw || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/.test(raw)) failure();
    const value = Number(raw!.replace(/[dD]/, "E"));
    if (!Number.isFinite(value)) failure();
    return value;
  };
  const nx = number("NAXIS1"), ny = number("NAXIS2"), ra0 = number("CRVAL1"), dec0 = number("CRVAL2");
  const px0 = number("CRPIX1"), py0 = number("CRPIX2");
  const cd11 = number("CD1_1"), cd12 = number("CD1_2"), cd21 = number("CD2_1"), cd22 = number("CD2_2");
  if (![nx, ny].every(n => Number.isSafeInteger(n) && n > 0 && n <= 200000)
    || ra0 < 0 || ra0 >= 360 || dec0 <= -90 || dec0 >= 90
    || Math.abs(cd11 * cd22 - cd12 * cd21) < 1e-16
    || Math.max(Math.hypot(cd11, cd21) * nx, Math.hypot(cd12, cd22) * ny) > 10) failure();
  const rad = Math.PI / 180, latitude = dec0 * rad;
  const corners = [[0.5, 0.5], [nx + 0.5, 0.5], [nx + 0.5, ny + 0.5], [0.5, ny + 0.5]].flatMap(([px, py]) => {
    const x = (cd11 * (px! - px0) + cd12 * (py! - py0)) * rad;
    const y = (cd21 * (px! - px0) + cd22 * (py! - py0)) * rad;
    const denominator = Math.cos(latitude) - y * Math.sin(latitude);
    const ra = (ra0 + Math.atan2(x, denominator) / rad + 360) % 360;
    const dec = Math.atan2(Math.sin(latitude) + y * Math.cos(latitude), Math.hypot(denominator, x)) / rad;
    return [ra, dec].map(value => Number(value.toFixed(12)));
  });
  return { kind: "fits-wcs-frame", instrument, filter: filter!, sRegion: `POLYGON ICRS ${corners.join(" ")}`,
    sourceUrl: input.packageUrl, memberName: input.memberName, sha256: input.headerSha256 };
}
