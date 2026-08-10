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
