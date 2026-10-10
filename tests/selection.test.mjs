import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloud, createDemoCloud, parsePointCloud, parseCloudJSON } from '../src/core/cloud.js';
import { buildOctree, projectPoint } from '../src/core/octree.js';
import { StableSelector, scorePoint, SELECTION_MODES, SCORE_WEIGHTS } from '../src/core/selection.js';

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const camera = () => ({ viewProjection: identity(), width: 800, height: 600, position: [0, 0, 3] });
function points(n = 40) {
  return createCloud({ positions: Array.from({ length: n }, (_, i) => [-0.8 + (i % 10) * 0.16, -0.7 + Math.floor(i / 10) * 0.3, 0]).flat(),
    normals: Array.from({ length: n }, () => [0, 0, 1]).flat(), radii: Array(n).fill(0.01), geometry: Array(n).fill(0.2), saliency: Array(n).fill(0.2), confidence: Array(n).fill(1) });
}

test('canonical schema rejects malformed or non-finite input', () => {
  assert.throws(() => createCloud({ positions: [0, 1] }), /triples/);
  assert.throws(() => createCloud({ positions: [NaN, 0, 0] }), /invalid/);
  assert.throws(() => createCloud({ positions: [1e100, 0, 0] }), /Float32/);
  assert.throws(() => createCloud({ positions: [0, 0, 0], normals: [0, 0, 0] }), /zero/);
  assert.throws(() => createCloud({ positions: [0, 0, 0], radii: [-1] }), /invalid/);
  assert.throws(() => createCloud({ positions: [0, 0, 0], colors: [1.1, 0, 0] }), /invalid/);
  assert.throws(() => createCloud({ positions: [0, 0, 0, 1, 1, 1], ids: [8, 8] }), /unique/);
  assert.throws(() => parseCloudJSON('{"version":2,"positions":[0,0,0]}'), /Unsupported/);
  assert.throws(() => parsePointCloud('0 0 Infinity'), /Non-finite/);
  assert.throws(() => parsePointCloud('0 0 0\n1 2 3 4 5 6'), /inconsistent/);
  assert.throws(() => parsePointCloud('0 0 0\n1 1 1', { maxPoints: 1 }), /limit/);
});

test('raw XYZ fallback is disclosed without invented geometric features', () => {
  const c = parsePointCloud('# demo\n0 0 0 255 0 128\n1 2 3 0 255 0', { name: 'xyz' });
  assert.equal(c.count, 2); assert.deepEqual([...c.ids], [0, 1]);
  assert.equal(c.colors[0], 1); assert.ok(Math.abs(c.colors[2] - 128 / 255) < 1e-6);
  assert.deepEqual([...c.geometry], [0, 0]); assert.deepEqual([...c.confidence], [0, 0]);
  assert.equal(c.metadata.preprocessorRecommended, true);
  assert.match(c.metadata.featureSources.normals, /fallback/);
});

test('ASCII PLY follows reordered optional scalar property names', () => {
  const ply = ['ply', 'format ascii 1.0', 'element vertex 2', 'property uchar blue', 'property float z', 'property float nx', 'property float x', 'property uchar red', 'property float ny', 'property float y', 'property float nz', 'property uchar green', 'end_header', '128 3 0 1 255 0 2 2 0', '0 6 1 4 0 0 5 0 255'].join('\n');
  const c = parsePointCloud(ply);
  assert.deepEqual([...c.positions], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...c.normals], [0, 0, 1, 1, 0, 0]);
  assert.equal(c.colors[0], 1); assert.equal(c.colors[4], 1);
  assert.throws(() => parsePointCloud(ply.replace('format ascii', 'format binary_little_endian')), /ASCII/);
  assert.throws(() => parsePointCloud(ply.replace('128 3 0 1', '128 NaN 0 1')), /Non-finite/);
});

test('synthetic scene is deterministic and discloses analytical/proxy sources', () => {
  const a = createDemoCloud({ count: 12000, seed: 13 }), b = createDemoCloud({ count: 12000, seed: 13 });
  assert.equal(a.count, 12000); assert.deepEqual(a.positions, b.positions); assert.deepEqual(a.colors, b.colors);
  assert.ok(a.bounds.diagonal > 4); assert.match(a.metadata.featureSources.geometry, /NOT PCA/);
  assert.ok(a.metadata.objectCounts.every(n => n > 0));
  for (let i = 0; i < a.count; i += 29) assert.ok(Math.abs(Math.hypot(...a.normals.slice(i * 3, i * 3 + 3)) - 1) < 1e-6);
});

test('octree traversal has a bounded deterministic pool and visible retained source IDs', () => {
  const c = points(100), tree = buildOctree(c, { leafSize: 4 });
  const cam = camera(), first = tree.getCandidates(cam, { budget: 8, maxCandidates: 25 });
  const second = tree.getCandidates(cam, { budget: 8, maxCandidates: 25 });
  assert.deepEqual(first.indices, second.indices); assert.ok(first.indices.length <= 25);
  assert.ok(first.coverageIndices.length > 0); assert.ok(first.stats.nodesVisited > 1);
  assert.equal(new Set(first.indices).size, first.indices.length);
  const retained = [c.ids[1], c.ids[2], c.ids[3]];
  const next = tree.getCandidates(cam, { budget: 8, maxCandidates: 25, retainedIds: retained });
  for (const id of retained) assert.ok([...next.visibleRetainedIds].includes(id));
  const moved = camera(); moved.viewProjection[12] = 10;
  const empty = tree.getCandidates(moved, { budget: 8, retainedIds: retained });
  assert.equal(empty.indices.length, 0); assert.ok(empty.stats.nodesRejected > 0);
});

test('shared radius scale includes viewport-overlapping surfels whose centers are outside', () => {
  const c = createCloud({ positions: [1.03, 0, 0], radii: [0.01] }), cam = camera(), tree = buildOctree(c);
  const unscaled = projectPoint(c, 0, cam);
  assert.equal(unscaled.visible, false); assert.equal(tree.getCandidates(cam, { budget: 1 }).indices.length, 0);
  const scaled = { ...cam, radiusScale: 4 }, projection = projectPoint(c, 0, scaled);
  assert.ok(projection.ndcX > 1); assert.equal(projection.visible, true);
  assert.ok(Math.abs(projection.projectedRadius - unscaled.projectedRadius * 4) < 1e-8);
  assert.deepEqual([...tree.getCandidates(scaled, { budget: 1 }).indices], [0]);
  assert.equal(new StableSelector(c).update({ indices: [0] }, scaled, { budget: 1 }).count, 1);
  for (const radiusScale of [0, -1, NaN, Infinity, '2']) {
    assert.throws(() => projectPoint(c, 0, { ...cam, radiusScale }), /radiusScale/);
    assert.throws(() => tree.getCandidates({ ...cam, radiusScale }, { budget: 1 }), /radiusScale/);
  }
});

test('all scoring methods have equal hard budgets over common candidates', () => {
  const c = points(), cam = camera(), common = buildOctree(c).getCandidates(cam, { budget: 13 });
  for (const mode of SELECTION_MODES) {
    const a = new StableSelector(c).update(common, cam, { budget: 13, mode });
    const b = new StableSelector(c).update(common, cam, { budget: 13, mode });
    assert.equal(a.count, 13); assert.deepEqual(a.ids, b.ids);
    assert.ok([...common.coverageIndices].every(i => [...a.indices].includes(i)));
    const still = new StableSelector(c).update(common, cam, { budget: 100, mode });
    assert.equal(still.count, 40);
  }
});

test('importance follows multiplicative projected support with matched geometry/silhouette weights', () => {
  const c = createCloud({ positions: [0, 0, 0], normals: [0, 0, 1], radii: [0.01], geometry: [0.5], saliency: [0.25], confidence: [1] });
  const cam = camera(), projection = projectPoint(c, 0, cam);
  const e = scorePoint(c, 0, cam, 'screen', projection);
  assert.ok(e > 0); assert.ok(Math.abs(scorePoint(c, 0, cam, 'geometry', projection) - e * 1.5) < 1e-8);
  assert.ok(Math.abs(scorePoint(c, 0, cam, 'full', projection) - e * 1.75) < 1e-8);
  assert.equal(SCORE_WEIGHTS.geometry.geometry, SCORE_WEIGHTS.full.geometry);
  assert.equal(SCORE_WEIGHTS.geometry.silhouette, SCORE_WEIGHTS.full.silhouette);
  c.confidence[0] = 0;
  assert.equal(scorePoint(c, 0, cam, 'geometry', projection), e);
  assert.ok(Math.abs(scorePoint(c, 0, cam, 'full', projection) - e * 1.25) < 1e-8);
  c.confidence[0] = 1; c.normals.set([0, 1, 0]);
  const grazingE = scorePoint(c, 0, cam, 'screen', projection);
  assert.ok(Math.abs(scorePoint(c, 0, cam, 'geometry', projection) - grazingE * 2) < 1e-8);
  assert.ok(Math.abs(scorePoint(c, 0, cam, 'full', projection) - grazingE * 2.25) < 1e-8);
});

test('union-retained common pools include incumbents and fresh exploration candidates', () => {
  const c = points(100), cam = camera(), tree = buildOctree(c, { leafSize: 4 });
  // These IDs are visible: points in the first six rows have y <= 0.8.
  const retainedIds = Array.from({ length: 45 }, (_, i) => c.ids[i]);
  const common = tree.getCandidates(cam, { budget: 5, maxCandidates: 20, retainedIds });
  assert.equal(common.visibleRetainedIds.length, 45);
  assert.equal(common.stats.requestedCandidateCap, 20); assert.equal(common.stats.candidateCap, 50);
  assert.equal(common.indices.length, 50); assert.ok(common.indices.some(i => i >= 45));
  for (const id of retainedIds) assert.ok(common.indices.includes(c.idToIndex.get(id)));
});

test('discretionary membership swaps obey the discrete quota and stable ID tie break', () => {
  const c = points(20), cam = camera(), all = { indices: Uint32Array.from({ length: 20 }, (_, i) => i) };
  c.geometry.fill(0.1); c.geometry.fill(0.9, 0, 10);
  const selector = new StableSelector(c);
  const initial = selector.update(all, cam, { budget: 10, mode: 'geometry', emaSeconds: 0 });
  assert.deepEqual([...initial.ids], Array.from({ length: 10 }, (_, i) => i));
  c.geometry.fill(0, 0, 10); c.geometry.fill(1, 10);
  const changed = selector.update(all, cam, { budget: 10, mode: 'geometry', emaSeconds: 0, hysteresis: 0, swapQuota: 0.2 });
  assert.equal(changed.stats.swaps, 2); assert.equal(changed.stats.added, 2); assert.equal(changed.stats.removed, 2);
  assert.equal(changed.stats.maxSwaps, 2); assert.equal(changed.count, 10);
  const frozen = selector.update(all, cam, { budget: 10, mode: 'geometry', emaSeconds: 0, hysteresis: 0, swapQuota: 0.099 });
  assert.equal(frozen.stats.swaps, 0); assert.deepEqual(changed.ids, frozen.ids);
});

test('relative hysteresis suppresses marginal improvements', () => {
  const c = points(20), cam = camera(), all = { indices: Array.from({ length: 20 }, (_, i) => i) };
  c.geometry.fill(0.2); c.geometry.fill(0.8, 0, 10);
  const selector = new StableSelector(c); const first = selector.update(all, cam, { budget: 10, mode: 'geometry', emaSeconds: 0 });
  c.geometry.fill(0.9, 10);
  const next = selector.update(all, cam, { budget: 10, mode: 'geometry', emaSeconds: 0, hysteresis: 0.5, swapQuota: 1 });
  assert.deepEqual(first.ids, next.ids); assert.equal(next.stats.swaps, 0);
});

test('EMA uses elapsed seconds consistently across timestep subdivision', () => {
  const c = points(4), cam = camera(), all = { indices: [0, 1, 2, 3] }, a = new StableSelector(c), b = new StableSelector(c);
  const settings = { budget: 2, mode: 'geometry', emaSeconds: 0.5, swapQuota: 0 };
  a.update(all, cam, settings); b.update(all, cam, settings); c.geometry.fill(1);
  a.update(all, cam, { ...settings, dt: 0.1 });
  b.update(all, cam, { ...settings, dt: 0.05 }); b.update(all, cam, { ...settings, dt: 0.05 });
  for (const [i, value] of a._ema) assert.ok(Math.abs(value - b._ema.get(i)) < 1e-12);
});

test('offscreen removals and fills proceed even with a zero swap quota', () => {
  const c = createCloud({ positions: [-0.8, 0, 0, -0.6, 0, 0, 0.6, 0, 0, 0.8, 0, 0, -0.9, 0, 0, -0.7, 0, 0, -0.5, 0, 0, -0.3, 0, 0], radii: Array(8).fill(0.01) });
  const cam = camera(), selector = new StableSelector(c);
  selector.update({ indices: [0, 1, 2, 3] }, cam, { budget: 4, mode: 'uniform' });
  const moved = camera(); moved.viewProjection[12] = 0.8;
  const result = selector.update({ indices: [0, 1, 4, 5, 6, 7] }, moved, { budget: 4, mode: 'uniform', swapQuota: 0 });
  assert.equal(result.count, 4); assert.equal(result.stats.mandatoryRemovals, 2); assert.equal(result.stats.fills, 2); assert.equal(result.stats.swaps, 0);
  assert.ok([...result.indices].every(i => projectPoint(c, i, moved).visible));
});

test('candidate churn cannot silently evict still-visible retained points', () => {
  const c = points(20), cam = camera(), selector = new StableSelector(c);
  const first = selector.update({ indices: [0, 1, 2, 3, 4] }, cam, { budget: 5, mode: 'uniform' });
  const next = selector.update({ indices: [10, 11, 12, 13, 14] }, cam, { budget: 5, mode: 'uniform', swapQuota: 0 });
  assert.deepEqual(first.ids, next.ids); assert.equal(next.stats.removed, 0); assert.equal(next.stats.candidateCount, 10);
});

test('stable:false disables EMA, hysteresis, and quota and matches a fresh raw ranking', () => {
  const c = points(20), cam = camera(), all = { indices: Array.from({ length: 20 }, (_, i) => i) }, selector = new StableSelector(c);
  c.geometry.fill(0.1); c.geometry.fill(0.9, 0, 10);
  selector.update(all, cam, { budget: 10, mode: 'geometry' });
  c.geometry.fill(0, 0, 10); c.geometry.fill(1, 10);
  const next = selector.update(all, cam, { budget: 10, mode: 'geometry', stable: false, emaSeconds: 100, hysteresis: 100, swapQuota: 0, dt: 0 });
  const fresh = new StableSelector(c).update(all, cam, { budget: 10, mode: 'geometry', stable: false });
  assert.deepEqual(next.ids, fresh.ids); assert.equal(next.stats.temporalEnabled, false); assert.equal(next.stats.alpha, 1);
  assert.equal(next.stats.swaps, 10); assert.equal(next.stats.maxSwaps, 10); assert.equal(next.stats.mandatoryRemovals, 0);
  const churn = selector.update({ indices: [0, 1, 2, 3, 4] }, cam, { budget: 10, mode: 'geometry', stable: false });
  assert.deepEqual([...churn.ids], [0, 1, 2, 3, 4]); assert.equal(churn.stats.mandatoryRemovals, 0);
});

test('zero budget, explicit restart, and malformed selection settings are handled', () => {
  const c = points(), cam = camera(), all = { indices: [0, 1, 2, 3, 4] }, selector = new StableSelector(c);
  assert.equal(selector.update(all, cam, { budget: 3 }).count, 3);
  const zero = selector.update(all, cam, { budget: 0 }); assert.equal(zero.count, 0); assert.equal(selector.selectedIds.length, 0);
  const restarted = selector.update(all, cam, { budget: 3, restart: true }); assert.equal(restarted.stats.initialized, true);
  assert.throws(() => selector.update({ indices: [999] }, cam, { budget: 3 }), /out of range/);
  assert.throws(() => selector.update(all, cam, { budget: 3, dt: NaN }), /finite/);
  assert.throws(() => selector.update(all, cam, { budget: 3, swapQuota: 2 }), /\[0,1\]/);
  assert.throws(() => buildOctree(c).getCandidates({ ...cam, width: 0 }, { budget: 3 }), /viewport/);
  assert.throws(() => scorePoint(c, 0, cam, 'mystery'), /Unknown/);
});
