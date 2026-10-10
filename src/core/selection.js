import { projectPoint, validateCamera } from './octree.js';

export const SELECTION_MODES = ['uniform', 'screen', 'geometry', 'full'];
export const SCORE_WEIGHTS = Object.freeze({
  screen: Object.freeze({ geometry: 0, saliency: 0, silhouette: 0 }),
  geometry: Object.freeze({ geometry: 1, saliency: 0, silhouette: 0.5 }),
  full: Object.freeze({ geometry: 1, saliency: 1, silhouette: 0.5 }),
});
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function hashId(id) {
  let x = (id ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ x >>> 16, 0x21f0aaad); x = Math.imul(x ^ x >>> 15, 0x735a2d97);
  return ((x ^ x >>> 15) >>> 0) / 4294967296;
}

/** Heuristic importance, not an optimized perceptual objective. Projected
 * support is a bounded log of elliptical surfel pixel area; silhouette is the
 * grazing-angle proxy 1-|normal dot view|, not an occlusion silhouette test. */
export function scorePoint(cloud, index, camera, mode = 'full', projection = projectPoint(cloud, index, camera)) {
  if (!SELECTION_MODES.includes(mode)) throw new Error(`Unknown selection mode ${mode}`);
  if (!projection.visible) return 0;
  if (mode === 'uniform') return 0.02 + 0.98 * hashId(cloud.ids[index]);
  const j = 3 * index, dx = camera.position[0] - cloud.positions[j], dy = camera.position[1] - cloud.positions[j + 1], dz = camera.position[2] - cloud.positions[j + 2], d = Math.hypot(dx, dy, dz);
  const cosine = d > 1e-8 ? Math.abs((cloud.normals[j] * dx + cloud.normals[j + 1] * dy + cloud.normals[j + 2] * dz) / d) : 1;
  const support = clamp(Math.log1p(Math.PI * projection.projectedRadius ** 2 * Math.max(0.08, cosine)) / Math.log1p(5000), 0, 1);
  const silhouette = 1 - clamp(cosine, 0, 1);
  const w = SCORE_WEIGHTS[mode];
  // Missing/uncertain geometry receives zero contribution; supplied confidence
  // modulates normal-dependent geometry and silhouette, not color annotations.
  return support * (1 + w.geometry * cloud.geometry[index] * cloud.confidence[index]
    + w.saliency * cloud.saliency[index] + w.silhouette * silhouette * cloud.confidence[index]);
}

/** Stateful selection: visibility removals and empty-slot fills are separate
 * from discretionary paired swaps. A swap requires a relative hysteresis win
 * and is capped by floor(swapQuota * B) per update. Call with fixed dt.
 * stable:false reranks the supplied pool from raw scores on every update,
 * ignoring EMA, hysteresis, and the swap quota. */
export class StableSelector {
  constructor(cloud) {
    this.cloud = cloud; this._selected = new Set(); this._ema = new Map(); this._mode = null; this._budget = null;
  }
  get selectedIds() { return Uint32Array.from([...this._selected].map(i => this.cloud.ids[i])); }
  get selectedIndices() { return Uint32Array.from(this._selected); }
  reset() { this._selected.clear(); this._ema.clear(); this._mode = null; this._budget = null; }

  update(candidateResult, camera, { budget, mode = 'full', stable = true, dt = 1 / 60, emaSeconds = 0.12, hysteresis = 0.12, swapQuota = 0.08, restart = false } = {}) {
    validateCamera(camera);
    if (!Number.isInteger(budget) || budget < 0) throw new Error('budget must be a nonnegative integer');
    if (!SELECTION_MODES.includes(mode)) throw new Error(`Unknown selection mode ${mode}`);
    if (typeof stable !== 'boolean') throw new Error('stable must be boolean');
    for (const [name, v] of Object.entries({ dt, emaSeconds, hysteresis, swapQuota })) if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be finite and nonnegative`);
    if (swapQuota > 1) throw new Error('swapQuota must be in [0,1]');
    const cloud = this.cloud, B = Math.min(budget, cloud.count), previous = new Set(this._selected);
    const initialized = this._mode == null || restart || this._mode !== mode || this._budget !== B;
    if (initialized) { this._selected.clear(); this._ema.clear(); }
    this._mode = mode; this._budget = B;
    const source = candidateResult?.indices ?? candidateResult;
    if (!source || (!Array.isArray(source) && !ArrayBuffer.isView(source))) throw new Error('Candidates must supply an indices array');
    const candidates = new Set(), projections = new Map();
    const projectionFor = i => { if (!projections.has(i)) projections.set(i, projectPoint(cloud, i, camera)); return projections.get(i); };
    for (const i of source) {
      if (!Number.isInteger(i) || i < 0 || i >= cloud.count) throw new Error('Candidate index is out of range');
      if (projectionFor(i).visible) candidates.add(i);
    }
    let mandatoryRemovals = 0;
    if (!stable) {
      if (!initialized) for (const i of previous) if (!projectionFor(i).visible) mandatoryRemovals++;
      this._selected.clear(); this._ema.clear();
    } else for (const i of [...this._selected]) {
      if (!projectionFor(i).visible) { this._selected.delete(i); this._ema.delete(i); mandatoryRemovals++; }
      else candidates.add(i); // Retain visible points even during candidate-pool churn.
    }
    const coverage = new Set();
    for (const i of candidateResult?.coverageIndices || []) {
      if (!Number.isInteger(i) || i < 0 || i >= cloud.count) throw new Error('Coverage index is out of range');
      if (candidates.has(i)) coverage.add(i);
    }
    const alpha = !stable || emaSeconds === 0 ? 1 : -Math.expm1(-dt / emaSeconds), scores = new Map();
    for (const i of candidates) {
      const raw = scorePoint(cloud, i, camera, mode, projectionFor(i)), prior = this._ema.get(i);
      const smooth = prior == null ? raw : prior + alpha * (raw - prior); this._ema.set(i, smooth); scores.set(i, smooth);
    }
    // Forget departed candidates instead of letting stale scores accrue forever.
    for (const i of this._ema.keys()) if (!candidates.has(i)) this._ema.delete(i);
    const compare = (a, b) => Number(coverage.has(b)) - Number(coverage.has(a)) || scores.get(b) - scores.get(a) || cloud.ids[a] - cloud.ids[b];
    const ranked = [...candidates].sort(compare);
    let budgetRemovals = 0;
    if (this._selected.size > B) {
      const worst = [...this._selected].sort(compare).reverse();
      while (this._selected.size > B) { this._selected.delete(worst.shift()); budgetRemovals++; }
    }
    let fills = 0;
    for (const i of ranked) { if (this._selected.size >= B) break; if (!this._selected.has(i)) { this._selected.add(i); fills++; } }
    const maxSwaps = stable ? Math.floor(swapQuota * B) : B, outside = ranked.filter(i => !this._selected.has(i));
    const inside = [...this._selected].sort(compare).reverse();
    let swaps = 0, challengerCursor = 0, incumbentCursor = 0;
    if (stable && !initialized) while (swaps < maxSwaps && challengerCursor < outside.length && incumbentCursor < inside.length) {
      const challenger = outside[challengerCursor], incumbent = inside[incumbentCursor];
      if (coverage.has(incumbent)) break; // Shared spatial representatives are protected.
      const wins = coverage.has(challenger) || scores.get(challenger) > scores.get(incumbent) * (1 + hysteresis);
      if (!wins) break;
      this._selected.delete(incumbent); this._selected.add(challenger); swaps++; challengerCursor++; incumbentCursor++;
    }
    const indices = Uint32Array.from([...this._selected].sort((a, b) => cloud.ids[a] - cloud.ids[b])), ids = Uint32Array.from(indices, i => cloud.ids[i]);
    let added = 0, removed = 0, retained = 0;
    for (const i of this._selected) previous.has(i) ? retained++ : added++;
    for (const i of previous) if (!this._selected.has(i)) removed++;
    if (!stable && !initialized) {
      swaps = Math.min(added, Math.max(0, removed - mandatoryRemovals));
      fills = Math.max(0, added - swaps);
    }
    const union = previous.size + this._selected.size - retained;
    return { indices, ids, count: indices.length, stats: { budget: B, candidateCount: candidates.size, initialized,
      swaps, maxSwaps, mandatoryRemovals, budgetRemovals, fills, added, removed, retained,
      turnover: Math.max(added, removed) / Math.max(1, B), jaccard: union ? retained / union : 1,
      coverageCount: [...coverage].filter(i => this._selected.has(i)).length, alpha, temporalEnabled: stable,
      notes: stable ? 'Turnover includes visibility removals/fills and restart changes; discretionary paired swaps alone obey maxSwaps.'
        : 'Temporal controls disabled: raw importance reranking of the supplied common pool each update.' } };
  }
}
