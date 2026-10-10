/** Deterministic camera paths for a scene centered at the origin with size 2. */
export const CAMERA_PATH_NAMES = Object.freeze(['orbit', 'zoom', 'boundary', 'cut']);

/**
 * cameraAt(pathName, tSeconds, {duration=12, previousTime=null}) returns
 * {eye:[x,y,z], target:[x,y,z], cut:boolean}. Time clamps to [0,duration].
 * Supply previousTime to detect a cut reliably with irregular animation-frame
 * intervals. Without it, cut is true only within half a 60 Hz frame of the cut.
 * For larger/smaller scenes multiply eye and target by sceneScale.
 */
export function cameraAt(pathName, tSeconds, {
  duration = 12, previousTime = null, sceneScale = 1,
} = {}) {
  if (!CAMERA_PATH_NAMES.includes(pathName)) throw new RangeError(`unknown camera path: ${pathName}`);
  if (!Number.isFinite(tSeconds)) throw new TypeError('tSeconds must be finite');
  if (!Number.isFinite(duration) || duration <= 0) throw new RangeError('duration must be positive');
  if (!Number.isFinite(sceneScale) || sceneScale <= 0) throw new RangeError('sceneScale must be positive');
  if (previousTime !== null && !Number.isFinite(previousTime)) throw new TypeError('previousTime must be finite or null');
  const time = Math.min(duration, Math.max(0, tSeconds));
  const u = time / duration;
  let eye;
  let target = [0, 0, 0];
  let cut = false;
  if (pathName === 'orbit') {
    const angle = 2 * Math.PI * u;
    eye = [3.8 * Math.sin(angle), 1.1 + 0.35 * Math.sin(2 * angle), 3.8 * Math.cos(angle)];
  } else if (pathName === 'zoom') {
    const distance = 1.8 + 4.2 * (0.5 + 0.5 * Math.cos(2 * Math.PI * u));
    eye = [distance * 0.32, distance * 0.2, distance];
  } else if (pathName === 'boundary') {
    const sweep = Math.sin(2 * Math.PI * u);
    eye = [0.35 * sweep, 0.55, 3.4];
    target = [1.55 * sweep, 0.25 * Math.sin(4 * Math.PI * u), 0];
  } else {
    const cutTime = duration / 2;
    const afterCut = time >= cutTime;
    const localU = afterCut ? 2 * u - 1 : 2 * u;
    const angle = (afterCut ? 1.15 * Math.PI : 0) + 0.45 * localU;
    eye = [3.4 * Math.sin(angle), afterCut ? 1.65 : 0.5, 3.4 * Math.cos(angle)];
    cut = previousTime === null ? Math.abs(time - cutTime) < 1 / 120 :
      (previousTime < cutTime && time >= cutTime) || (previousTime >= cutTime && time < cutTime);
  }
  return { eye: eye.map(value => value * sceneScale), target: target.map(value => value * sceneScale), cut };
}
