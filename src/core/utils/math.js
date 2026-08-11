/**
 * Vector3 represented as an array of 3 numbers.
 * @typedef {number[]} Vector3
 */

/**
 * Creates a perspective projection matrix.
 * @param {number} fovY - Field of view in radians.
 * @param {number} aspect - Aspect ratio.
 * @param {number} near - Near clipping plane.
 * @param {number} far - Far clipping plane.
 * @returns {Float32Array} 16-element column-major matrix.
 */
export function mat4Perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, near * far * nf, 0]);
}

/**
 * Subtracts two vectors.
 * @param {Vector3} a
 * @param {Vector3} b
 * @returns {Vector3} Resulting vector
 */
export function vSub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/**
 * Computes the cross product of two vectors.
 * @param {Vector3} a
 * @param {Vector3} b
 * @returns {Vector3} Resulting vector
 */
export function vCross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * Computes the dot product of two vectors.
 * @param {Vector3} a
 * @param {Vector3} b
 * @returns {number} Dot product
 */
export function vDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Normalizes a vector.
 * @param {Vector3} a
 * @returns {Vector3} Normalized vector
 */
export function vNorm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/**
 * Creates a look-at view matrix.
 * @param {Vector3} eye - Camera position
 * @param {Vector3} center - Target position
 * @param {Vector3} up - Up vector
 * @returns {Float32Array} 16-element column-major matrix.
 */
export function mat4LookAt(eye, center, up) {
  const z = vNorm(vSub(eye, center));
  const x = vNorm(vCross(up, z));
  const y = vCross(z, x);
  return new Float32Array([
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -vDot(x, eye),
    -vDot(y, eye),
    -vDot(z, eye),
    1,
  ]);
}

/**
 * Multiplies two 4x4 matrices.
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {Float32Array} Resulting matrix
 */
export function mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/**
 * Adds two vectors.
 * @param {Vector3} a
 * @param {Vector3} b
 * @returns {Vector3} Resulting vector
 */
export function vAdd(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/**
 * Scales a vector by a scalar.
 * @param {Vector3} a
 * @param {number} s - Scalar
 * @returns {Vector3} Resulting vector
 */
export function vScale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/**
 * Applies a 4x4 matrix to a 3D point, returning homogeneous clip-space
 * coordinates [x, y, z, w]. Caller is responsible for the perspective
 * divide (x/w, y/w) — see projectToScreen() for the guarded version.
 * @param {Float32Array} m - 16-element column-major matrix
 * @param {Vector3} v - Point to transform
 * @returns {number[]} [x, y, z, w] in clip space
 */
export function mat4Apply(m, v) {
  const x = v[0], y = v[1], z = v[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

/**
 * Projects a world-space point to screen-space pixel coordinates.
 * Returns null if the point is behind (or too close to) the camera —
 * w <= epsilon means the perspective divide would be meaningless/inverted,
 * so callers must skip these points rather than including garbage
 * coordinates in a bounding-box computation (e.g. marquee select).
 * @param {Float32Array} viewProj - combined view*projection matrix
 * @param {Vector3} worldPoint
 * @param {number} screenW
 * @param {number} screenH
 * @returns {{x:number,y:number}|null}
 */
export function projectToScreen(viewProj, worldPoint, screenW, screenH) {
  const [cx, cy, , cw] = mat4Apply(viewProj, worldPoint);
  if (cw <= 1e-5) return null; // behind camera / at the eye, perspective divide unusable
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  return {
    x: (ndcX * 0.5 + 0.5) * screenW,
    y: (1 - (ndcY * 0.5 + 0.5)) * screenH,
  };
}

/**
 * Intersects a ray with a plane. Returns the world-space intersection
 * point, or null if the ray is parallel to the plane (or the plane is
 * behind the ray origin) — callers must skip the interaction on null
 * rather than silently continuing with a stale/garbage point.
 * @param {Vector3} ro - ray origin
 * @param {Vector3} rd - ray direction (should be normalized)
 * @param {Vector3} planePoint - any point on the plane
 * @param {Vector3} planeNormal - plane normal (should be normalized)
 */
export function rayPlaneIntersect(ro, rd, planePoint, planeNormal) {
  const denom = vDot(rd, planeNormal);
  if (Math.abs(denom) < 1e-7) return null; // ray parallel to plane
  const t = vDot(vSub(planePoint, ro), planeNormal) / denom;
  if (t < 0) return null; // plane is behind the ray origin
  return vAdd(ro, vScale(rd, t));
}

/**
 * Decomposes a 3x3 rotation matrix back into the (rx, ry, rz) Euler
 * angles (in degrees) matching this project's rotationMat3() convention
 * (R = Rz(rz) * Ry(ry) * Rx(rx), row-major, mat3Apply(R,v) = R*v).
 * Standard ZYX Tait-Bryan extraction; degenerates near the gimbal-lock
 * pole (|R[2][0]| ~ 1, i.e. ry ~ +-90deg) by folding all remaining
 * rotation into rz and leaving rx at 0 — a known, accepted limitation
 * shared by every plain-Euler (non-quaternion) rotate gizmo.
 * @param {number[]} m - 9-element row-major rotation matrix
 * @returns {{rx:number, ry:number, rz:number}} degrees
 */
export function mat3ToEulerXYZ(m) {
  const toDeg = 180 / Math.PI;
  const clampedR20 = Math.max(-1, Math.min(1, -m[6]));
  const ry = Math.asin(clampedR20);
  const cy = Math.cos(ry);
  let rx, rz;
  if (Math.abs(cy) > 1e-6) {
    rx = Math.atan2(m[7], m[8]);
    rz = Math.atan2(m[3], m[0]);
  } else {
    // Gimbal lock: rx and rz become redundant (same axis) — fold
    // everything into rz, leave rx at 0.
    rx = 0;
    rz = Math.atan2(-m[1], m[4]);
  }
  return { rx: rx * toDeg, ry: ry * toDeg, rz: rz * toDeg };
}

export function mat3RotX(a) {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
export function mat3RotY(a) {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
export function mat3RotZ(a) {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}
export function mat3Mul(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      o[r * 3 + c] = a[r * 3 + 0] * b[0 * 3 + c] + a[r * 3 + 1] * b[1 * 3 + c] + a[r * 3 + 2] * b[2 * 3 + c];
  return o;
}
export function mat3Transpose(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}
export function mat3Apply(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}
export function rotationMat3(rx, ry, rz) {
  const d = Math.PI / 180;
  return mat3Mul(mat3Mul(mat3RotZ(rz * d), mat3RotY(ry * d)), mat3RotX(rx * d));
}
