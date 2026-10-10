/** Canonical schema: flat xyz/nxyz/sRGB Float32Arrays; scalar Float32Arrays;
 * original, unique Uint32 source IDs. Feature arrays use the interval [0, 1]. */
export const MAX_INTERACTIVE_POINTS = 100000;

function numbers(value, length, label, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value == null) return Float32Array.from({ length }, (_, i) => typeof fallback === 'function' ? fallback(i) : fallback);
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) throw new Error(`${label} must be an array`);
  if (value.length !== length) throw new Error(`${label} must contain ${length} values`);
  const result = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const v = value[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${label}[${i}] is invalid`);
    result[i] = v;
    if (!Number.isFinite(result[i])) throw new Error(`${label}[${i}] exceeds Float32 range`);
  }
  return result;
}

export function createCloud(data) {
  if (!data || typeof data !== 'object') throw new Error('Point cloud must be an object');
  if (data.version != null && data.version !== 1) throw new Error('Unsupported cloud version');
  if (!data.positions || data.positions.length % 3) throw new Error('positions must contain complete xyz triples');
  const count = data.positions.length / 3;
  if (data.count != null && data.count !== count) throw new Error('count does not match positions');
  if (!Number.isSafeInteger(count) || count > MAX_INTERACTIVE_POINTS) throw new Error(`Interactive limit is ${MAX_INTERACTIVE_POINTS} points`);
  const positions = numbers(data.positions, count * 3, 'positions', 0);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], positions[3 * i + a]); max[a] = Math.max(max[a], positions[3 * i + a]); }
  if (!count) { min.fill(0); max.fill(0); }
  const center = min.map((v, a) => (v + max[a]) / 2);
  const diagonal = Math.hypot(...min.map((v, a) => max[a] - v));
  const defaultRadius = Math.max(diagonal / Math.sqrt(Math.max(1, count)) * 0.5, 0.001);
  const normals = numbers(data.normals, count * 3, 'normals', i => i % 3 === 2 ? 1 : 0);
  for (let i = 0; i < count; i++) {
    const j = 3 * i, length = Math.hypot(normals[j], normals[j + 1], normals[j + 2]);
    if (length < 1e-12) throw new Error(`normal ${i} has zero length`);
    normals[j] /= length; normals[j + 1] /= length; normals[j + 2] /= length;
  }
  const radii = numbers(data.radii, count, 'radii', defaultRadius, { min: Number.MIN_VALUE });
  for (const r of radii) if (!(r > 0)) throw new Error('radii must be positive');
  const ids = new Uint32Array(count), idToIndex = new Map();
  if (data.ids != null && data.ids.length !== count) throw new Error('ids length does not match count');
  for (let i = 0; i < count; i++) {
    const id = data.ids == null ? i : data.ids[i];
    if (!Number.isInteger(id) || id < 0 || id > 0xffffffff || idToIndex.has(id)) throw new Error('ids must be unique unsigned 32-bit integers');
    ids[i] = id; idToIndex.set(id, i);
  }
  const metadata = { ...(data.metadata || {}) };
  metadata.featureSources = {
    normals: data.normals ? 'supplied' : 'constant +Z fallback; preprocessing recommended',
    radii: data.radii ? 'supplied' : 'bounding-diagonal spacing fallback',
    geometry: data.geometry ? 'supplied' : 'unavailable (zero)',
    saliency: data.saliency ? 'supplied' : 'unavailable (zero)',
    confidence: data.confidence ? 'supplied' : 'unavailable (zero)',
    ...(metadata.featureSources || {}),
  };
  metadata.preprocessorRecommended = metadata.preprocessorRecommended ?? (!data.normals || !data.radii || !data.geometry);
  return {
    version: 1, name: String(data.name || 'Point cloud'), count, positions, normals,
    colors: numbers(data.colors, count * 3, 'colors', i => [0.53, 0.71, 0.84][i % 3], { min: 0, max: 1 }), radii,
    geometry: numbers(data.geometry, count, 'geometry', 0, { min: 0, max: 1 }),
    saliency: numbers(data.saliency, count, 'saliency', 0, { min: 0, max: 1 }),
    confidence: numbers(data.confidence, count, 'confidence', 0, { min: 0, max: 1 }),
    ids, idToIndex, metadata, bounds: { min, max, center, diagonal, radius: diagonal / 2 },
  };
}

export function parseCloudJSON(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid cloud JSON'); }
  return createCloud(data);
}

function finiteToken(token, context) {
  if (token == null || token.trim() === '') throw new Error(`Missing ${context}`);
  const value = Number(token);
  if (!Number.isFinite(value)) throw new Error(`Non-finite ${context}`);
  return value;
}

/** XYZ accepts x y z, xyz RGB, xyz normal RGB, or xyz normal. Six-column
 * rows default to RGB; set xyzSixColumns:'normals' to resolve the ambiguity. */
export function parsePointCloud(text, options = {}) {
  if (typeof text !== 'string') throw new Error('File content must be text');
  const { name = 'Imported cloud', format = 'auto', maxPoints = MAX_INTERACTIVE_POINTS, xyzSixColumns = 'colors' } = options;
  const limit = Math.min(MAX_INTERACTIVE_POINTS, maxPoints);
  if (!Number.isInteger(limit) || limit < 0) throw new Error('maxPoints must be a nonnegative integer');
  if (format === 'json' || (format === 'auto' && text.trimStart().startsWith('{'))) return parseCloudJSON(text);
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const isPLY = format === 'ply' || (format === 'auto' && lines[0].trim() === 'ply');
  const positions = [], normals = [], colors = [], radii = [], geometry = [], saliency = [], confidence = [], ids = [];
  let hasNormals = false, hasColors = false, hasRadii = false, hasGeometry = false, hasSaliency = false, hasConfidence = false, hasIds = false;
  if (isPLY) {
    if (lines[0].trim() !== 'ply') throw new Error('Missing PLY magic');
    let end = -1, ascii = false, current = null;
    const elements = [];
    for (let i = 1; i < lines.length; i++) {
      const words = lines[i].trim().split(/\s+/);
      if (words[0] === 'format') ascii = words[1] === 'ascii' && words[2] === '1.0';
      if (words[0] === 'element') {
        const size = finiteToken(words[2], 'PLY element count');
        if (!Number.isInteger(size) || size < 0) throw new Error('Invalid PLY element count');
        current = { name: words[1], size, properties: [] }; elements.push(current);
      }
      if (words[0] === 'property') {
        if (!current) throw new Error('PLY property before element');
        current.properties.push({ type: words[1], name: words.at(-1), list: words[1] === 'list' });
      }
      if (words[0] === 'end_header') { end = i; break; }
    }
    if (!ascii) throw new Error('Only ASCII PLY 1.0 is supported in the browser');
    if (end < 0) throw new Error('Missing PLY end_header');
    const vertices = elements.filter(e => e.name === 'vertex');
    if (vertices.length !== 1) throw new Error('PLY needs exactly one vertex element');
    const vertex = vertices[0];
    if (vertex.size > limit) throw new Error(`Interactive limit is ${limit} points; preprocess or downsample first`);
    if (vertex.properties.some(p => p.list)) throw new Error('List-valued vertex properties are unsupported');
    const propertyNames = vertex.properties.map(p => p.name);
    if (new Set(propertyNames).size !== propertyNames.length) throw new Error('Duplicate PLY vertex properties');
    const indexes = Object.fromEntries(propertyNames.map((p, i) => [p, i]));
    for (const key of ['x', 'y', 'z']) if (indexes[key] == null) throw new Error(`PLY missing ${key}`);
    const triplet = keys => {
      const supplied = keys.filter(k => indexes[k] != null).length;
      if (supplied && supplied !== 3) throw new Error(`PLY needs all ${keys.join('/')} properties`);
      return supplied === 3;
    };
    hasNormals = triplet(['nx', 'ny', 'nz']); hasColors = triplet(['red', 'green', 'blue']);
    hasRadii = indexes.radius != null; hasGeometry = indexes.geometry != null; hasSaliency = indexes.saliency != null; hasConfidence = indexes.confidence != null; hasIds = indexes.id != null;
    let cursor = end + 1;
    for (const element of elements) for (let row = 0; row < element.size; row++) {
      while (cursor < lines.length && !lines[cursor].trim()) cursor++;
      if (cursor >= lines.length) throw new Error('PLY body shorter than declared element counts');
      const tokens = lines[cursor++].trim().split(/\s+/);
      if (element !== vertex) continue;
      if (tokens.length !== vertex.properties.length) throw new Error(`PLY vertex ${row} has the wrong number of values`);
      const values = tokens.map((v, i) => finiteToken(v, `PLY vertex ${row}, ${propertyNames[i]}`));
      const get = key => values[indexes[key]];
      positions.push(get('x'), get('y'), get('z'));
      if (hasNormals) normals.push(get('nx'), get('ny'), get('nz'));
      if (hasColors) for (const key of ['red', 'green', 'blue']) {
        const type = vertex.properties[indexes[key]].type;
        const byte = ['uchar', 'uint8', 'char', 'int8', 'ushort', 'uint16', 'short', 'int16', 'int', 'int32', 'uint', 'uint32'].includes(type);
        colors.push(get(key) / (byte ? 255 : 1));
      }
      if (hasRadii) radii.push(get('radius')); if (hasGeometry) geometry.push(get('geometry'));
      if (hasSaliency) saliency.push(get('saliency')); if (hasConfidence) confidence.push(get('confidence')); if (hasIds) ids.push(get('id'));
    }
  } else {
    if (!['auto', 'xyz', 'txt'].includes(format)) throw new Error(`Unsupported format ${format}`);
    let columns = null;
    for (let row = 0; row < lines.length; row++) {
      const line = lines[row].trim();
      if (!line || line.startsWith('#')) continue;
      const tokens = line.split(/[\s,]+/);
      if (![3, 6, 9].includes(tokens.length)) throw new Error(`XYZ row ${row + 1} needs 3, 6, or 9 values`);
      columns ??= tokens.length;
      if (tokens.length !== columns) throw new Error('XYZ rows have inconsistent columns');
      if (positions.length / 3 >= limit) throw new Error(`Interactive limit is ${limit} points; preprocess or downsample first`);
      const values = tokens.map(v => finiteToken(v, `XYZ row ${row + 1}`));
      positions.push(...values.slice(0, 3));
      hasNormals = columns === 9 || (columns === 6 && xyzSixColumns === 'normals');
      hasColors = columns === 9 || (columns === 6 && xyzSixColumns !== 'normals');
      if (hasNormals) normals.push(...values.slice(3, 6));
      if (hasColors) colors.push(...values.slice(columns === 9 ? 6 : 3));
    }
    if (hasColors && colors.some(v => v > 1)) for (let i = 0; i < colors.length; i++) colors[i] /= 255;
  }
  if (!positions.length) throw new Error('The file contains no points');
  return createCloud({ name, positions, normals: hasNormals ? normals : undefined, colors: hasColors ? colors : undefined,
    radii: hasRadii ? radii : undefined, geometry: hasGeometry ? geometry : undefined, saliency: hasSaliency ? saliency : undefined,
    confidence: hasConfidence ? confidence : undefined, ids: hasIds ? ids : undefined,
    metadata: { source: isPLY ? 'ASCII PLY' : 'XYZ', preprocessorRecommended: !hasNormals || !hasRadii || !hasGeometry,
      notes: 'Raw imports do not estimate PCA geometry, saliency, or confidence. Missing features are zero; missing normals are constant +Z.' } });
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => { state += 0x6d2b79f5; let t = Math.imul(state ^ state >>> 15, 1 | state); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** A designed scene, not an empirical benchmark. All normals are analytical;
 * geometry/color saliency are explicitly disclosed design proxies. */
export function createDemoCloud({ count = 14400, seed = 5411 } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_INTERACTIVE_POINTS) throw new Error('Invalid demo count');
  const random = randomGenerator(seed), positions = [], normals = [], colors = [], radii = [], geometry = [], saliency = [], confidence = [];
  const counts = [0.34, 0.22, 0.16, 0.12, 0.13].map(f => Math.floor(count * f)); counts.push(count - counts.reduce((a, b) => a + b, 0));
  const add = (p, n, c, r, g, s) => { positions.push(...p); normals.push(...n); colors.push(...c); radii.push(r); geometry.push(g); saliency.push(s); confidence.push(1); };
  const tau = Math.PI * 2, golden = Math.PI * (3 - Math.sqrt(5));
  // Front ellipsoid: Fibonacci samples and exact implicit-surface normals.
  for (let i = 0; i < counts[0]; i++) {
    const y = 1 - 2 * (i + 0.5) / counts[0], a = i * golden, ring = Math.sqrt(1 - y * y), x = ring * Math.cos(a), z = ring * Math.sin(a);
    const patch = z > 0.4 && x > -0.1 && x < 0.6 && y > -0.15 && y < 0.4;
    add([-0.95 + 0.78 * x, 0.05 + 1.02 * y, 0.12 + 0.65 * z], [x / 0.78, y / 1.02, z / 0.65], patch ? [0.96, 0.31, 0.21] : [0.21, 0.68 + 0.08 * y, 0.76], 0.58 * Math.sqrt(8.3 / Math.max(1, counts[0])), 0.04 + 0.1 * Math.abs(z), patch ? 0.95 : 0.12);
  }
  // Torus at a different depth; smaller tube emphasizes curved thin support.
  for (let i = 0; i < counts[1]; i++) {
    const u = tau * random(), v = tau * random(), cv = Math.cos(v), sv = Math.sin(v), cu = Math.cos(u), su = Math.sin(u), r = 0.13, R = 0.64;
    add([0.94 + (R + r * cv) * cu, 0.35 + (R + r * cv) * su, 0.05 + r * sv], [cv * cu, cv * su, sv], [0.55, 0.47 + 0.15 * sv, 0.92], 0.58 * Math.sqrt(4 * Math.PI ** 2 * R * r / Math.max(1, counts[1])), 0.4 + 0.25 * (1 - cv) / 2, 0.3);
  }
  // Rear box: explicit faces, with an edge-distance geometry proxy.
  const half = [0.57, 0.68, 0.24], boxCenter = [0.96, -0.16, -0.88];
  for (let i = 0; i < counts[2]; i++) {
    const face = i % 6, axis = Math.floor(face / 2), sign = face % 2 ? 1 : -1, p = [0, 0, 0], n = [0, 0, 0]; n[axis] = sign;
    let edgeDistance = Infinity;
    for (let k = 0; k < 3; k++) { p[k] = k === axis ? sign * half[k] : (random() * 2 - 1) * half[k]; if (k !== axis) edgeDistance = Math.min(edgeDistance, half[k] - Math.abs(p[k])); p[k] += boxCenter[k]; }
    const edge = Math.exp(-edgeDistance / 0.055);
    add(p, n, [0.94, 0.68 - 0.18 * edge, 0.24], 0.58 * Math.sqrt(5.5 / Math.max(1, counts[2])), edge * 0.92, 0.18 + edge * 0.3);
  }
  // Four narrow tubes traverse the scene at varying depth.
  for (let i = 0; i < counts[3]; i++) {
    const arm = i % 4, t = random(), a = tau * random(), x0 = -0.28 + arm * 0.18, z0 = 0.35 - arm * 0.28, dx = 0.14 * (arm - 1.5), dy = 1.66, dz = -0.52;
    const length = Math.hypot(dx, dy, dz), tangent = [dx / length, dy / length, dz / length], basis = [tangent[1], -tangent[0], 0], bl = Math.hypot(...basis); for (let k = 0; k < 3; k++) basis[k] /= bl;
    const cross = [tangent[1] * basis[2] - tangent[2] * basis[1], tangent[2] * basis[0] - tangent[0] * basis[2], tangent[0] * basis[1] - tangent[1] * basis[0]], n = basis.map((v, k) => v * Math.cos(a) + cross[k] * Math.sin(a)), radius = 0.026;
    add([x0 + dx * t + radius * n[0], -0.98 + dy * t + radius * n[1], z0 + dz * t + radius * n[2]], n, [0.96, 0.34 + arm * 0.09, 0.3], 0.58 * Math.sqrt(4 * tau * radius * length / Math.max(1, counts[3])), 0.96, 0.75);
  }
  // Rear planar wall with a localized high-color-contrast checker annotation.
  for (let i = 0; i < counts[4]; i++) {
    const x = random() * 4.2 - 2.1, y = random() * 2.5 - 1.25, patch = x < -0.65 && y > 0.2, checker = (Math.floor(x * 12) + Math.floor(y * 12)) % 2;
    add([x, y, -1.7], [0, 0, 1], patch ? (checker ? [0.94, 0.85, 0.25] : [0.17, 0.22, 0.28]) : [0.22 + y * 0.015, 0.29, 0.37], 0.58 * Math.sqrt(10.5 / Math.max(1, counts[4])), 0.01, patch ? 0.9 : 0.04);
  }
  // Foreground disk gives an occlusion boundary and small rim feature.
  for (let i = 0; i < counts[5]; i++) {
    const rho = 0.22 * Math.sqrt(random()), a = tau * random(), rim = Math.max(0, (rho - 0.18) / 0.04);
    add([-0.05 + rho * Math.cos(a), -0.79 + rho * Math.sin(a), 0.84], [0, 0, 1], [0.98, 0.58, 0.12], 0.58 * Math.sqrt(Math.PI * 0.22 ** 2 / Math.max(1, counts[5])), rim * 0.85, 0.7);
  }
  return createCloud({ name: 'Designed multi-depth surfel scene', count, positions, normals, colors, radii, geometry, saliency, confidence,
    metadata: { source: 'deterministic synthetic', seed, preprocessorRecommended: false, objectCounts: counts,
      featureSources: { normals: 'analytical surface normals', radii: 'known object surface area / sample-count spacing proxy', geometry: 'designed curvature class and box/disk edge-distance proxy; NOT PCA', saliency: 'designed color-annotation proxy; NOT measured perceptual saliency', confidence: '1 for exact analytical normals' },
      notes: 'Synthetic feature proxies are for controlled demonstrations. Use offline neighborhood PCA for imported geometry.' } });
}
