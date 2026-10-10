/**
 * Numerical image comparisons; no renderer or DOM dependency.
 *
 * Inputs are flat RGBA Uint8Array/Uint8ClampedArray images, four bytes per pixel.
 * Depth is raw WebGL window depth in [0, 1], with clearDepth = 1. Matrices are
 * column-major WebGL/OpenGL view-projection matrices; clip z is in [-w, +w].
 * Pixel row zero is the BOTTOM row, matching gl.readPixels. All frame buffers
 * supplied to one call must use this same orientation. RGB errors ignore alpha
 * and divide byte differences by 255. Depth errors remain in raw depth units;
 * they are not world-space or linear-depth distances.
 *
 * The temporal metric reprojects CURRENT reference surface points into the
 * PREVIOUS reference image, using nearest-neighbor samples. Its mask uses only
 * reference geometry: foreground, in-bounds projection, and depth consistency.
 * Missing budget pixels deliberately remain in the metric. It measures mean
 * |(budget_t - reference_t) - warped(budget_previous - reference_previous)|,
 * not raw image change. Camera motion and reference-image change are removed
 * before computing the residual, but motion at subpixel sampling resolution
 * remains a limitation of nearest-neighbor reprojection.
 */

const CHANNEL_SCALE = 255;

function pixelCount(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('width and height must be positive integers');
  }
  return width * height;
}

function requireRGBA(values, count, name) {
  if (!(values instanceof Uint8Array || values instanceof Uint8ClampedArray) || values.length !== count * 4) {
    throw new TypeError(`${name} must be a byte RGBA array of length width * height * 4`);
  }
}

function requireDepth(values, count, name) {
  if (!values || values.length !== count) {
    throw new TypeError(`${name} must have length width * height`);
  }
}

function requireMatrix(values, name) {
  if (!values || values.length !== 16 || Array.from(values).some(value => !Number.isFinite(value))) {
    throw new TypeError(`${name} must contain 16 finite column-major values`);
  }
}

function isForegroundDepth(value, clearDepth = 1) {
  return Number.isFinite(value) && value >= 0 && value < clearDepth;
}

function isForegroundColor(rgba, offset, backgroundRGBA, backgroundTolerance) {
  return Math.abs(rgba[offset] - backgroundRGBA[0]) > backgroundTolerance ||
    Math.abs(rgba[offset + 1] - backgroundRGBA[1]) > backgroundTolerance ||
    Math.abs(rgba[offset + 2] - backgroundRGBA[2]) > backgroundTolerance;
}

/** Mean absolute RGB error in [0, 1]; null for an empty optional mask. */
export function rgbMAE(referenceRGBA, budgetRGBA, { width, height, mask = null } = {}) {
  const count = pixelCount(width, height);
  requireRGBA(referenceRGBA, count, 'referenceRGBA');
  requireRGBA(budgetRGBA, count, 'budgetRGBA');
  if (mask && mask.length !== count) throw new TypeError('mask must have length width * height');
  let sum = 0;
  let validPixels = 0;
  for (let p = 0; p < count; p++) {
    if (mask && !mask[p]) continue;
    const offset = p * 4;
    for (let c = 0; c < 3; c++) sum += Math.abs(referenceRGBA[offset + c] - budgetRGBA[offset + c]);
    validPixels++;
  }
  return validPixels ? sum / (validPixels * 3 * CHANNEL_SCALE) : null;
}

/**
 * Compare one rendered image to its full-density reference.
 * Foreground comes from depth when BOTH depths exist, otherwise RGB distance
 * from backgroundRGBA. silhouetteMismatchRate is symmetric difference / union.
 * foregroundHoleRate is missing reference foreground / reference foreground.
 * A rate whose denominator is zero is null; counts always remain available.
 * depthCorrespondenceError compares only pixels with foreground in both images;
 * depthCorrespondenceCoverage reports the fraction of reference foreground used.
 */
export function evaluateImagePair({
  referenceRGBA, budgetRGBA, width, height,
  referenceDepth = null, budgetDepth = null,
  backgroundRGBA = [0, 0, 0, 255], backgroundTolerance = 0, clearDepth = 1,
}) {
  const count = pixelCount(width, height);
  requireRGBA(referenceRGBA, count, 'referenceRGBA');
  requireRGBA(budgetRGBA, count, 'budgetRGBA');
  const hasDepth = referenceDepth !== null && budgetDepth !== null;
  if ((referenceDepth !== null) !== (budgetDepth !== null)) {
    throw new TypeError('provide both referenceDepth and budgetDepth, or neither');
  }
  if (hasDepth) {
    requireDepth(referenceDepth, count, 'referenceDepth');
    requireDepth(budgetDepth, count, 'budgetDepth');
  }
  let referenceForegroundPixels = 0;
  let budgetForegroundPixels = 0;
  let foregroundHolePixels = 0;
  let silhouetteMismatchPixels = 0;
  let unionPixels = 0;
  let depthCorrespondencePixels = 0;
  let depthSum = 0;
  for (let p = 0; p < count; p++) {
    const offset = p * 4;
    const referenceForeground = hasDepth ? isForegroundDepth(referenceDepth[p], clearDepth) :
      isForegroundColor(referenceRGBA, offset, backgroundRGBA, backgroundTolerance);
    const budgetForeground = hasDepth ? isForegroundDepth(budgetDepth[p], clearDepth) :
      isForegroundColor(budgetRGBA, offset, backgroundRGBA, backgroundTolerance);
    referenceForegroundPixels += Number(referenceForeground);
    budgetForegroundPixels += Number(budgetForeground);
    foregroundHolePixels += Number(referenceForeground && !budgetForeground);
    silhouetteMismatchPixels += Number(referenceForeground !== budgetForeground);
    unionPixels += Number(referenceForeground || budgetForeground);
    if (hasDepth && referenceForeground && budgetForeground) {
      depthSum += Math.abs(referenceDepth[p] - budgetDepth[p]);
      depthCorrespondencePixels++;
    }
  }
  return {
    maeRgb: rgbMAE(referenceRGBA, budgetRGBA, { width, height }),
    foregroundHoleRate: referenceForegroundPixels ? foregroundHolePixels / referenceForegroundPixels : null,
    silhouetteMismatchRate: unionPixels ? silhouetteMismatchPixels / unionPixels : null,
    depthCorrespondenceError: depthCorrespondencePixels ? depthSum / depthCorrespondencePixels : null,
    depthCorrespondenceCoverage: hasDepth && referenceForegroundPixels ? depthCorrespondencePixels / referenceForegroundPixels : null,
    referenceForegroundPixels, budgetForegroundPixels, foregroundHolePixels,
    silhouetteMismatchPixels, depthCorrespondencePixels,
  };
}

/** Invert a column-major 4x4 matrix. Throws for a singular matrix. */
export function invertMatrix4(matrix) {
  requireMatrix(matrix, 'matrix');
  const rows = Array.from({ length: 4 }, (_, r) => [
    matrix[r], matrix[4 + r], matrix[8 + r], matrix[12 + r],
    Number(r === 0), Number(r === 1), Number(r === 2), Number(r === 3),
  ]);
  for (let column = 0; column < 4; column++) {
    let pivot = column;
    for (let r = column + 1; r < 4; r++) {
      if (Math.abs(rows[r][column]) > Math.abs(rows[pivot][column])) pivot = r;
    }
    if (Math.abs(rows[pivot][column]) <= Number.EPSILON) throw new RangeError('view-projection matrix is singular');
    [rows[pivot], rows[column]] = [rows[column], rows[pivot]];
    const divisor = rows[column][column];
    for (let c = 0; c < 8; c++) rows[column][c] /= divisor;
    for (let r = 0; r < 4; r++) {
      if (r === column) continue;
      const scale = rows[r][column];
      for (let c = 0; c < 8; c++) rows[r][c] -= scale * rows[column][c];
    }
  }
  const result = new Float64Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) result[c * 4 + r] = rows[r][4 + c];
  }
  return result;
}

function transform4(matrix, x, y, z, w) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12] * w,
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13] * w,
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14] * w,
    matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15] * w,
  ];
}

/**
 * Convert a pixel center and raw depth to a world point. x,y are integer pixel
 * indices with bottom-left origin. Pass an INVERSE view-projection matrix.
 */
export function unprojectPixelToWorld(x, y, depth, inverseViewProjection, width, height) {
  const homogeneous = transform4(inverseViewProjection,
    2 * (x + 0.5) / width - 1, 2 * (y + 0.5) / height - 1, 2 * depth - 1, 1);
  if (Math.abs(homogeneous[3]) <= Number.EPSILON) return null;
  return homogeneous.slice(0, 3).map(value => value / homogeneous[3]);
}

/**
 * Project a world point to continuous PIXEL-CENTER coordinates and raw depth.
 * Integer x,y denote exact pixel centers. inBounds requires the point to be in
 * front of the camera, inside the image footprint, and within the depth range.
 */
export function projectWorldToPixel(world, viewProjection, width, height) {
  const clip = transform4(viewProjection, world[0], world[1], world[2], 1);
  if (clip[3] <= Number.EPSILON) return { x: NaN, y: NaN, depth: NaN, inBounds: false };
  const x = (clip[0] / clip[3] + 1) * width / 2 - 0.5;
  const y = (clip[1] / clip[3] + 1) * height / 2 - 0.5;
  const depth = (clip[2] / clip[3] + 1) / 2;
  return {
    x, y, depth,
    inBounds: Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(depth) &&
      x >= -0.5 && x < width - 0.5 && y >= -0.5 && y < height - 0.5 && depth >= 0 && depth <= 1,
  };
}

/**
 * Reprojection-aware temporal residual MAE; range [0,2], null on an empty mask.
 * Each frame: {referenceRGBA, budgetRGBA, referenceDepth, viewProjection}.
 * budgetDepth is neither needed nor consulted. depthTolerance is an absolute
 * tolerance in raw WebGL depth units, not a physical distance. Exact camera
 * cuts should pass cut:true and are excluded instead of scored as instability.
 */
export function temporalResidualMetric({
  previous, current, width, height, depthTolerance = 0.0001, clearDepth = 1, cut = false,
}) {
  const count = pixelCount(width, height);
  if (!Number.isFinite(depthTolerance) || depthTolerance < 0) throw new RangeError('depthTolerance must be nonnegative');
  for (const [name, frame] of [['previous', previous], ['current', current]]) {
    if (!frame) throw new TypeError(`${name} frame is required`);
    requireRGBA(frame.referenceRGBA, count, `${name}.referenceRGBA`);
    requireRGBA(frame.budgetRGBA, count, `${name}.budgetRGBA`);
    requireDepth(frame.referenceDepth, count, `${name}.referenceDepth`);
    requireMatrix(frame.viewProjection, `${name}.viewProjection`);
  }
  if (cut) return { temporalResidualRgb: null, validPixelCount: 0, validPixelFraction: 0, excludedByCut: true };
  const inverseCurrent = invertMatrix4(current.viewProjection);
  let sum = 0;
  let validPixelCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const depth = current.referenceDepth[p];
      if (!isForegroundDepth(depth, clearDepth)) continue;
      const world = unprojectPixelToWorld(x, y, depth, inverseCurrent, width, height);
      if (!world) continue;
      const projected = projectWorldToPixel(world, previous.viewProjection, width, height);
      if (!projected.inBounds) continue;
      const previousX = Math.floor(projected.x + 0.5);
      const previousY = Math.floor(projected.y + 0.5);
      if (previousX < 0 || previousX >= width || previousY < 0 || previousY >= height) continue;
      const previousP = previousY * width + previousX;
      const previousDepth = previous.referenceDepth[previousP];
      if (!isForegroundDepth(previousDepth, clearDepth) || Math.abs(previousDepth - projected.depth) > depthTolerance) continue;
      const offset = p * 4;
      const previousOffset = previousP * 4;
      for (let c = 0; c < 3; c++) {
        const currentError = current.budgetRGBA[offset + c] - current.referenceRGBA[offset + c];
        const previousError = previous.budgetRGBA[previousOffset + c] - previous.referenceRGBA[previousOffset + c];
        sum += Math.abs(currentError - previousError);
      }
      validPixelCount++;
    }
  }
  return {
    temporalResidualRgb: validPixelCount ? sum / (validPixelCount * 3 * CHANNEL_SCALE) : null,
    validPixelCount, validPixelFraction: validPixelCount / count, excludedByCut: false,
  };
}
