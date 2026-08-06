import { VERTEX_SHADER, FRAGMENT_SHADER } from './shader.glsl.js';
import { mat4Perspective, mat4LookAt, mat4Multiply, vAdd } from '../../utils/math.js';

export async function initWebGL(canvas) {
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 tidak tersedia di browser ini.');

  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();
  window.addEventListener('resize', resize);

  function compileShader(type, source) {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s));
    }
    return s;
  }
  const vs = compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog));
  }
  gl.useProgram(prog);

  const aPos = gl.getAttribLocation(prog, 'aPosition');
  const aNor = gl.getAttribLocation(prog, 'aNormal');
  const aCol = gl.getAttribLocation(prog, 'aColor');

  const uViewProj = gl.getUniformLocation(prog, 'uViewProj');
  const uCameraPos = gl.getUniformLocation(prog, 'uCameraPos');
  const uFogDensity = gl.getUniformLocation(prog, 'uFogDensity');

  return {
    createMesh(vertexData, indexData) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);

      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW);

      const stride = 9 * 4;
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(aNor);
      gl.vertexAttribPointer(aNor, 3, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(aCol);
      gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, stride, 24);

      const ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.STATIC_DRAW);

      gl.bindVertexArray(null);

      return {
        vao,
        vbo,
        ibo,
        destroy: () => {
          gl.deleteBuffer(vbo);
          gl.deleteBuffer(ibo);
          gl.deleteVertexArray(vao);
        },
      };
    },

    draw(cameraState, chunkEids, Renderable, RenderMesh) {
      gl.clearColor(0.53, 0.72, 0.86, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      const aspect = canvas.width / canvas.height;
      const proj = mat4Perspective(Math.PI / 3, aspect, 0.1, 500);
      const { eye, yaw, pitch } = cameraState;
      const forward = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
      const center = vAdd(eye, forward);
      const view = mat4LookAt(eye, center, [0, 1, 0]);
      const viewProj = mat4Multiply(proj, view);

      gl.useProgram(prog);
      gl.uniformMatrix4fv(uViewProj, false, viewProj);
      gl.uniform3fv(uCameraPos, eye);
      gl.uniform1f(uFogDensity, 0.006);

      for (const eid of chunkEids) {
        const mesh = RenderMesh.meshes[eid];
        if (!mesh) continue;
        gl.bindVertexArray(mesh.vao);
        gl.drawElements(gl.TRIANGLES, Renderable.indexCount[eid], gl.UNSIGNED_INT, 0);
      }
      gl.bindVertexArray(null);
    },
  };
}
