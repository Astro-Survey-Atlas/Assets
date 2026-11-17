import assert from "node:assert/strict";
import test from "node:test";
import { decodeViewPose, encodeViewPose, withViewParam, type ViewPose } from "../site/src/atlas/view-link.js";

const pose: ViewPose = { position: [0.1234567, -2.5, 1.75], target: [0, 0, 0], up: [0, 1, 0], fov: 48 };

test("view pose round-trips with bounded precision", () => {
  const decoded = decodeViewPose(encodeViewPose(pose));
  assert.ok(decoded);
  assert.deepEqual(decoded.target, [0, 0, 0]);
  assert.deepEqual(decoded.up, [0, 1, 0]);
  assert.equal(decoded.fov, 48);
  assert.ok(Math.abs(decoded.position[0] - 0.1234567) < 1e-5);
  assert.equal(encodeViewPose(decoded), encodeViewPose(pose));
});

test("damaged or unsafe view values are rejected, not clamped", () => {
  const bad = [
    "", null, undefined, "1,2,3", "a,b,c,d,e,f,g,h,i,j", "1,2,3,0,0,0,0,1,0,NaN",
    "1,2,3,0,0,0,0,1,0,0",          // fov too small
    "1,2,3,0,0,0,0,1,0,500",        // fov too large
    "100,0,0,0,0,0,0,1,0,48",       // camera far outside the viewer's range
    "1,0,0,1,0,0,0,1,0,48",         // camera sitting on its target
    "1,0,0,0,0,0,0,0,0,48",         // degenerate up vector
    "1e3,0,0,0,0,0,0,1,0,48",       // exponent notation is not produced by the encoder
    "1,0,0,0,0,0,0,1,0,48,9",       // extra field
  ];
  for (const value of bad) assert.equal(decodeViewPose(value as string | null | undefined), null, String(value));
  assert.equal(decodeViewPose("1".repeat(300)), null);
});

test("withViewParam keeps other parameters and removes the view when absent", () => {
  const withView = withViewParam("https://example.test/atlas/?survey=desi&product=p1", pose);
  const url = new URL(withView);
  assert.equal(url.searchParams.get("survey"), "desi");
  assert.equal(url.searchParams.get("product"), "p1");
  assert.equal(decodeViewPose(url.searchParams.get("view"))?.fov, 48);
  const cleared = new URL(withViewParam(withView, null));
  assert.equal(cleared.searchParams.has("view"), false);
  assert.equal(cleared.searchParams.get("survey"), "desi");
});
