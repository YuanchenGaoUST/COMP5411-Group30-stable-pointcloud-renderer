import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateImagePair, rgbMAE, temporalResidualMetric,
  invertMatrix4, projectWorldToPixel, unprojectPixelToWorld,
} from '../src/core/metrics.js';
import { cameraAt, CAMERA_PATH_NAMES } from '../src/core/camera-paths.js';

const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const rgba = values => new Uint8Array(values.flatMap(value => Array.isArray(value) ? [...value, 255] : [value, value, value, 255]));
const frame = (reference, budget, depth, matrix = IDENTITY) => ({
  referenceRGBA: rgba(reference), budgetRGBA: rgba(budget),
  referenceDepth: new Float32Array(depth), viewProjection: matrix,
});
function close(actual, expected, tolerance = 1e-7) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);
}

test('RGB MAE is normalized, ignores alpha, and reports an empty mask as null', () => {
  close(rgbMAE(rgba([255, 100]), rgba([0, 100]), { width: 2, height: 1 }), 0.5);
  const ref = new Uint8Array([40, 50, 60, 0]);
  const budget = new Uint8Array([40, 50, 60, 255]);
  assert.equal(rgbMAE(ref, budget, { width: 1, height: 1 }), 0);
  assert.equal(rgbMAE(ref, budget, { width: 1, height: 1, mask: [0] }), null);
});

test('image holes, silhouette, and depth error use explicit denominators', () => {
  const result = evaluateImagePair({
    referenceRGBA: rgba([100, 150, 0]), budgetRGBA: rgba([100, 0, 150]), width: 3, height: 1,
    referenceDepth: new Float32Array([0.2, 0.3, 1]), budgetDepth: new Float32Array([0.4, 1, 0.5]),
  });
  assert.equal(result.referenceForegroundPixels, 2);
  assert.equal(result.foregroundHolePixels, 1);
  close(result.foregroundHoleRate, 0.5);
  close(result.silhouetteMismatchRate, 2 / 3);
  close(result.depthCorrespondenceError, 0.2);
  close(result.depthCorrespondenceCoverage, 0.5);
  assert.equal(result.depthCorrespondencePixels, 1);
});

test('RGB background masks work when depth is unavailable', () => {
  const result = evaluateImagePair({
    referenceRGBA: rgba([0, 80]), budgetRGBA: rgba([80, 0]), width: 2, height: 1,
  });
  assert.equal(result.foregroundHoleRate, 1);
  assert.equal(result.silhouetteMismatchRate, 1);
  assert.equal(result.depthCorrespondenceError, null);
  assert.equal(result.depthCorrespondenceCoverage, null);
});

test('identical temporal residuals remain zero despite reference image changes', () => {
  const previous = frame([80, 100], [90, 80], [0.4, 0.6]);
  const current = frame([110, 50], [120, 30], [0.4, 0.6]);
  const result = temporalResidualMetric({ previous, current, width: 2, height: 1 });
  assert.equal(result.temporalResidualRgb, 0);
  assert.equal(result.validPixelCount, 2);
  assert.equal(result.validPixelFraction, 1);
});

test('column-major view translation reprojects residuals to the correct pixels', () => {
  const translated = new Float64Array(IDENTITY);
  translated[12] = 2 / 3; // At width 3, +2/3 NDC means +1 pixel.
  const previous = frame([40, 80, 140], [45, 110, 130], [0.5, 0.5, 0.5], translated);
  const current = frame([100, 120, 150], [130, 110, 0], [0.5, 0.5, 0.5]);
  const result = temporalResidualMetric({ previous, current, width: 3, height: 1 });
  assert.equal(result.temporalResidualRgb, 0);
  assert.equal(result.validPixelCount, 2); // Last current pixel projects beyond previous frame.
  close(result.validPixelFraction, 2 / 3);
});

test('a budget hole contributes error and is never excluded by a budget-depth mask', () => {
  const previous = frame([255, 255], [255, 255], [0.5, 0.5]);
  const current = frame([255, 255], [0, 255], [0.5, 0.5]);
  current.budgetDepth = new Float32Array([1, 0.5]);
  const result = temporalResidualMetric({ previous, current, width: 2, height: 1 });
  close(result.temporalResidualRgb, 0.5);
  assert.equal(result.validPixelCount, 2);
});

test('temporal errors retain their signs before differencing', () => {
  const previous = frame([255], [0], [0.5]);
  const current = frame([0], [255], [0.5]);
  const result = temporalResidualMetric({ previous, current, width: 1, height: 1 });
  assert.equal(result.temporalResidualRgb, 2);
  assert.equal(result.validPixelCount, 1);
});

test('vertical reprojection respects bottom-left buffer row order', () => {
  const translated = new Float64Array(IDENTITY);
  translated[13] = 1; // At height 2, +1 NDC means one row upward.
  const previous = frame([10, 50], [10, 70], [0.5, 0.5], translated);
  const current = frame([20, 100], [40, 0], [0.5, 0.5]);
  const result = temporalResidualMetric({ previous, current, width: 1, height: 2 });
  assert.equal(result.temporalResidualRgb, 0);
  assert.equal(result.validPixelCount, 1);
});

test('reference-depth disocclusions are excluded before residual aggregation', () => {
  const previous = frame([255, 100], [255, 100], [0.2, 0.5]);
  const current = frame([255, 100], [0, 100], [0.7, 0.5]);
  const result = temporalResidualMetric({ previous, current, width: 2, height: 1 });
  assert.equal(result.temporalResidualRgb, 0);
  assert.equal(result.validPixelCount, 1);
});

test('default raw-depth consistency tolerance is strict and remains configurable', () => {
  const previous = frame([255], [255], [0.5]);
  const current = frame([255], [0], [0.501]);
  const strict = temporalResidualMetric({ previous, current, width: 1, height: 1 });
  assert.equal(strict.temporalResidualRgb, null);
  const permissive = temporalResidualMetric({ previous, current, width: 1, height: 1, depthTolerance: 0.002 });
  assert.equal(permissive.temporalResidualRgb, 1);
});

test('no valid correspondence returns null, including backgrounds and camera cuts', () => {
  const empty = frame([0], [0], [1]);
  const result = temporalResidualMetric({ previous: empty, current: empty, width: 1, height: 1 });
  assert.equal(result.temporalResidualRgb, null);
  assert.equal(result.validPixelCount, 0);
  assert.equal(result.validPixelFraction, 0);
  const foreground = frame([100], [0], [0.5]);
  const cut = temporalResidualMetric({ previous: foreground, current: foreground, width: 1, height: 1, cut: true });
  assert.equal(cut.temporalResidualRgb, null);
  assert.equal(cut.excludedByCut, true);
});

test('perspective project/unproject round trip respects bottom-left pixel centers', () => {
  const projection = new Float64Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, -1.02, -1, 0, 0, -0.202, 0]);
  const inverse = invertMatrix4(projection);
  for (const [x, y, depth] of [[0, 0, 0.1], [31, 23, 0.5], [63, 47, 0.99]]) {
    const world = unprojectPixelToWorld(x, y, depth, inverse, 64, 48);
    const projected = projectWorldToPixel(world, projection, 64, 48);
    assert.equal(projected.inBounds, true);
    close(projected.x, x);
    close(projected.y, y);
    close(projected.depth, depth);
  }
});

test('malformed buffers and singular matrices produce explicit errors', () => {
  assert.throws(() => rgbMAE(new Uint8Array(1), rgba([0]), { width: 1, height: 1 }), /RGBA/);
  assert.throws(() => invertMatrix4(new Float64Array(16)), /singular/);
  assert.throws(() => evaluateImagePair({ referenceRGBA: rgba([0]), budgetRGBA: rgba([0]),
    referenceDepth: [0.5], width: 1, height: 1 }), /both/);
});

test('camera paths are deterministic, finite, and detect cut crossings', () => {
  for (const path of CAMERA_PATH_NAMES) {
    const camera = cameraAt(path, 3, { duration: 12 });
    assert.deepEqual(cameraAt(path, 3, { duration: 12 }), camera);
    assert.ok([...camera.eye, ...camera.target].every(Number.isFinite));
  }
  assert.deepEqual(cameraAt('orbit', -1), cameraAt('orbit', 0));
  assert.deepEqual(cameraAt('zoom', 50), cameraAt('zoom', 12));
  assert.equal(cameraAt('cut', 6.1, { previousTime: 5.9 }).cut, true);
  assert.equal(cameraAt('cut', 6.2, { previousTime: 6.1 }).cut, false);
  assert.throws(() => cameraAt('unknown', 0), /unknown camera path/);
});
