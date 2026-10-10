/** Cameras use a column-major OpenGL viewProjection matrix, viewport width /
 * height in pixels, and world-space position. Clip depth is [-1, 1]. The
 * optional positive radiusScale matches the renderer's shared multiplier. */
function cameraRadiusScale(camera) {
  const scale = camera.radiusScale ?? 1;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) throw new Error('camera.radiusScale must be finite and positive');
  return scale;
}

export function validateCamera(camera) {
  const m = camera?.viewProjection;
  if (!m || m.length !== 16 || [...m].some(v => !Number.isFinite(v))) throw new Error('camera.viewProjection must contain 16 finite column-major values');
  if (!(camera.width > 0) || !Number.isFinite(camera.width) || !(camera.height > 0) || !Number.isFinite(camera.height)) throw new Error('Camera viewport dimensions must be positive');
  if (!camera.position || camera.position.length !== 3 || camera.position.some(v => !Number.isFinite(v))) throw new Error('Camera position must be a finite xyz triple');
  cameraRadiusScale(camera);
  return camera;
}

export function projectPoint(cloud, index, camera) {
  const m = camera.viewProjection, p = cloud.positions, j = index * 3, x = p[j], y = p[j + 1], z = p[j + 2];
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14], w = m[3] * x + m[7] * y + m[11] * z + m[15];
  const valid = w > 1e-8;
  const ndcX = valid ? cx / w : Infinity, ndcY = valid ? cy / w : Infinity, depth = valid ? cz / w : Infinity;
  const radius = cloud.radii[index] * cameraRadiusScale(camera), rx = valid ? radius * Math.hypot(m[0], m[4], m[8]) / w : 0, ry = valid ? radius * Math.hypot(m[1], m[5], m[9]) / w : 0;
  return { x: (ndcX * 0.5 + 0.5) * camera.width, y: (0.5 - ndcY * 0.5) * camera.height,
    ndcX, ndcY, depth, w, projectedRadius: Math.max(rx * camera.width, ry * camera.height) * 0.5,
    visible: valid && depth >= -1 && depth <= 1 && ndcX >= -1 - rx && ndcX <= 1 + rx && ndcY >= -1 - ry && ndcY <= 1 + ry };
}

function frustumPlanes(m) {
  const rows = Array.from({ length: 4 }, (_, r) => [m[r], m[r + 4], m[r + 8], m[r + 12]]), planes = [];
  for (let axis = 0; axis < 3; axis++) for (const sign of [1, -1]) planes.push(rows[3].map((v, a) => v + sign * rows[axis][a]));
  return planes;
}

function intersects(node, planes, radiusScale) {
  const padding = node.maxRadius * radiusScale;
  for (const p of planes) {
    const support = p[0] * (p[0] >= 0 ? node.max[0] + padding : node.min[0] - padding)
      + p[1] * (p[1] >= 0 ? node.max[1] + padding : node.min[1] - padding)
      + p[2] * (p[2] >= 0 ? node.max[2] + padding : node.min[2] - padding) + p[3];
    if (support < 0) return false;
  }
  return true;
}

function evenOrder(length) {
  // Breadth-first interval splitting yields deterministic, dispersed prefixes.
  const order = [], queue = [[0, length - 1]];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const [lo, hi] = queue[cursor];
    if (lo > hi) continue;
    const mid = Math.floor((lo + hi) / 2); order.push(mid);
    if (lo < mid) queue.push([lo, mid - 1]); if (mid < hi) queue.push([mid + 1, hi]);
  }
  return order;
}

export class Octree {
  constructor(cloud, { leafSize = 48, maxDepth = 10 } = {}) {
    if (!Number.isInteger(leafSize) || leafSize < 1 || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 24) throw new Error('Invalid octree settings');
    this.cloud = cloud; this.leafSize = leafSize; this.maxDepth = maxDepth; this.nodeCount = 0;
    const sorted = Array.from({ length: cloud.count }, (_, i) => i).sort((a, b) => cloud.ids[a] - cloud.ids[b]);
    this.root = this._build(sorted, 0);
  }

  _build(indices, depth) {
    this.nodeCount++;
    const cloud = this.cloud, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let maxRadius = 0;
    for (const i of indices) { maxRadius = Math.max(maxRadius, cloud.radii[i]); for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], cloud.positions[3 * i + a]); max[a] = Math.max(max[a], cloud.positions[3 * i + a]); } }
    if (!indices.length) { min.fill(0); max.fill(0); }
    const center = min.map((v, a) => (v + max[a]) / 2);
    let representative = indices[0], bestDistance = Infinity;
    for (const i of indices) {
      const d = center.reduce((sum, v, a) => sum + (cloud.positions[3 * i + a] - v) ** 2, 0);
      if (d < bestDistance || (d === bestDistance && cloud.ids[i] < cloud.ids[representative])) { bestDistance = d; representative = i; }
    }
    const node = { min, max, center, maxRadius, representative, depth, count: indices.length, children: null, indices: null };
    if (indices.length <= this.leafSize || depth >= this.maxDepth || Math.max(...min.map((v, a) => max[a] - v)) < 1e-9) { node.indices = indices; return node; }
    const bins = Array.from({ length: 8 }, () => []);
    for (const i of indices) { let code = 0; for (let a = 0; a < 3; a++) if (cloud.positions[3 * i + a] >= center[a]) code |= 1 << a; bins[code].push(i); }
    if (bins.some(bin => bin.length === indices.length)) { node.indices = indices; return node; }
    node.children = bins.filter(bin => bin.length).map(bin => this._build(bin, depth + 1));
    return node;
  }

  /** Common, method-independent candidate pool. Frustum-traverse octree leaves,
   * choose dispersed representatives, then fill in rounds across leaves.
   * Still-visible retained IDs enter first. maxCandidates is clamped to >= B
   * and expands to unique visible retained IDs plus B exploration slots when
   * necessary (never above the cloud count).
   * Thus lockstep ablations can share a union of retained sets without losing
   * an incumbent solely because of candidate traversal.
   * coverageIndices are shared coarse representatives (default 18% of B).
   * stats never claim an exact whole-cloud visibility count. */
  getCandidates(camera, { budget, maxCandidates, retainedIds = [], coverageFraction = 0.18 } = {}) {
    validateCamera(camera);
    if (!Number.isInteger(budget) || budget < 0) throw new Error('budget must be a nonnegative integer');
    if (maxCandidates != null && (!Number.isInteger(maxCandidates) || maxCandidates < 0)) throw new Error('maxCandidates must be a nonnegative integer');
    if (!Number.isFinite(coverageFraction) || coverageFraction < 0 || coverageFraction > 1) throw new Error('coverageFraction must be in [0,1]');
    const cloud = this.cloud;
    let cap = budget ? Math.min(cloud.count, Math.max(budget, maxCandidates ?? 4 * budget)) : 0;
    const selected = [], seen = new Set(), visibleRetainedIds = [], coverageIndices = [], leaves = [];
    const stats = { nodesVisited: 0, nodesRejected: 0, leavesVisited: 0, pointsProjected: 0, candidateCount: 0, requestedCandidateCap: cap, candidateCap: cap, retainedOverflow: 0, retainedVisible: 0, coverageCount: 0 };
    if (!cap) return { indices: new Uint32Array(), coverageIndices: new Uint32Array(), visibleRetainedIds: new Uint32Array(), stats };
    const projected = new Map();
    const visible = index => {
      if (!projected.has(index)) { projected.set(index, projectPoint(cloud, index, camera).visible); stats.pointsProjected++; }
      return projected.get(index);
    };
    const add = index => { if (index != null && selected.length < cap && !seen.has(index) && visible(index)) { selected.push(index); seen.add(index); return true; } return false; };
    const retainedIndices = [], retainedSeen = new Set();
    for (const id of retainedIds) {
      const index = cloud.idToIndex.get(id);
      if (index != null && !retainedSeen.has(index) && visible(index)) { retainedIndices.push(index); retainedSeen.add(index); }
    }
    cap = Math.min(cloud.count, Math.max(cap, retainedIndices.length + budget)); stats.candidateCap = cap;
    stats.retainedOverflow = Math.max(0, retainedIndices.length - stats.requestedCandidateCap);
    for (const index of retainedIndices) { add(index); visibleRetainedIds.push(cloud.ids[index]); }
    const planes = frustumPlanes(camera.viewProjection), radiusScale = cameraRadiusScale(camera), stack = [this.root];
    while (stack.length) {
      const node = stack.pop(); stats.nodesVisited++;
      if (!intersects(node, planes, radiusScale)) { stats.nodesRejected++; continue; }
      if (node.children) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
      else if (node.indices.length) {
        stats.leavesVisited++;
        let representative = node.representative;
        if (!visible(representative)) representative = node.indices.find(i => visible(i));
        if (representative != null) leaves.push({ node, representative, cursor: 0 });
      }
    }
    const order = evenOrder(leaves.length), coverageTarget = Math.min(budget, coverageFraction ? Math.max(1, Math.floor(budget * coverageFraction)) : 0, leaves.length);
    for (let k = 0; k < coverageTarget; k++) {
      const index = leaves[order[k]].representative;
      add(index); if (seen.has(index)) coverageIndices.push(index);
    }
    for (const j of order) add(leaves[j].representative);
    // At most each point is projected once; the output remains capped.
    let more = true;
    while (selected.length < cap && more) {
      more = false;
      for (const j of order) {
        const leaf = leaves[j];
        while (leaf.cursor < leaf.node.indices.length) {
          const index = leaf.node.indices[leaf.cursor++]; more = true;
          if (add(index)) break;
        }
        if (selected.length >= cap) break;
      }
    }
    stats.candidateCount = selected.length; stats.retainedVisible = visibleRetainedIds.length; stats.coverageCount = coverageIndices.length;
    return { indices: Uint32Array.from(selected), coverageIndices: Uint32Array.from(coverageIndices), visibleRetainedIds: Uint32Array.from(visibleRetainedIds), stats };
  }
}

export function buildOctree(cloud, options) { return new Octree(cloud, options); }
