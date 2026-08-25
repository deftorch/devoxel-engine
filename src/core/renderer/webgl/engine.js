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
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
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

  // --- Debug Primitives Setup (Fase 2) ---
  const DEBUG_VS = `#version 300 es
    layout(location=0) in vec3 aPosition;
    layout(location=1) in vec3 aColor;
    uniform mat4 uViewProj;
    out vec3 vColor;
    void main() {
      gl_Position = uViewProj * vec4(aPosition, 1.0);
      vColor = aColor;
    }
  `;
  const DEBUG_FS = `#version 300 es
    precision mediump float;
    in vec3 vColor;
    out vec4 fragColor;
    void main() {
      fragColor = vec4(vColor, 1.0);
    }
  `;
  const debugVs = compileShader(gl.VERTEX_SHADER, DEBUG_VS);
  const debugFs = compileShader(gl.FRAGMENT_SHADER, DEBUG_FS);
  const debugProg = gl.createProgram();
  gl.attachShader(debugProg, debugVs);
  gl.attachShader(debugProg, debugFs);
  gl.linkProgram(debugProg);
  if (!gl.getProgramParameter(debugProg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(debugProg));
  
  const d_uViewProj = gl.getUniformLocation(debugProg, 'uViewProj');
  
  let activeDebugDraws = [];

  function getDebugBufferGL(data) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    
    // xyz (3) + rgb (3) = 6 floats
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 6 * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 6 * 4, 12);
    
    gl.bindVertexArray(null);
    return { vao, vbo, count: data.length / 6 };
  }

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

      const iData32 = indexData instanceof Uint32Array ? indexData : new Uint32Array(indexData);
      const ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, iData32, gl.STATIC_DRAW);

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

      // ----------------------------------------------------
      // Debug Primitives Hook
      // ----------------------------------------------------
      if (activeDebugDraws.length > 0) {
        gl.useProgram(debugProg);
        gl.uniformMatrix4fv(d_uViewProj, false, viewProj);
        
        for (const draw of activeDebugDraws) {
          if (!draw.depthTest) gl.disable(gl.DEPTH_TEST);
          gl.bindVertexArray(draw.vao);
          gl.drawArrays(draw.topology, 0, draw.count);
          if (!draw.depthTest) gl.enable(gl.DEPTH_TEST);
        }
        gl.bindVertexArray(null);
      }
    },

    drawDebugPrimitives(cameraState, debugData) {
      // Clean up buffers from previous frame
      for (const draw of activeDebugDraws) {
        gl.deleteBuffer(draw.vbo);
        gl.deleteVertexArray(draw.vao);
      }
      activeDebugDraws = [];

      if (!debugData) return;

      if (debugData.lines) {
        for (const lineObj of debugData.lines) {
          const buf = getDebugBufferGL(lineObj.data);
          activeDebugDraws.push({ ...buf, topology: gl.LINES, depthTest: lineObj.depthTest !== false });
        }
      }
      if (debugData.tris) {
        for (const triObj of debugData.tris) {
          const buf = getDebugBufferGL(triObj.data);
          activeDebugDraws.push({ ...buf, topology: gl.TRIANGLES, depthTest: triObj.depthTest !== false });
        }
      }
    },

    // Mengekspos raw gl untuk kebutuhan eksternal
    gl
  };
}
