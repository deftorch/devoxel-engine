export const SHADER = /* wgsl */ `
struct Uniforms {
  viewProj : mat4x4<f32>,
  cameraPos : vec3<f32>,
  fogDensity : f32,
};
@group(0) @binding(0) var<uniform> u : Uniforms;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) normal : vec3<f32>,
  @location(1) color : vec3<f32>,
  @location(2) worldPos : vec3<f32>,
};

@vertex
fn vs_main(
  @location(0) position : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @location(2) color : vec3<f32>
) -> VOut {
  var out : VOut;
  out.pos = u.viewProj * vec4<f32>(position, 1.0);
  out.normal = normal;
  out.color = color;
  out.worldPos = position;
  return out;
}

fn getGridColor(uv : vec2<f32>) -> vec3<f32> {
  let grid = fract(uv * 2.0);
  let line = step(0.95, grid.x) + step(0.95, grid.y);
  return mix(vec3<f32>(0.7, 0.7, 0.7), vec3<f32>(0.2, 0.6, 0.9), clamp(line, 0.0, 1.0));
}

@fragment
fn fs_main(in : VOut) -> @location(0) vec4<f32> {
  let lightDir = normalize(vec3<f32>(0.45, 0.85, 0.3));
  let skyColor = vec3<f32>(0.53, 0.72, 0.86);
  let groundAmbient = vec3<f32>(0.30, 0.27, 0.23);

  let normal = normalize(in.normal);
  let hemi = clamp(normal.y * 0.5 + 0.5, 0.0, 1.0);
  let ambient = mix(groundAmbient, skyColor * 0.55, hemi);

  let diffuse = max(dot(normal, lightDir), 0.0);
  
  // --- Triplanar Mapping ---
  var blendWeights = abs(normal);
  blendWeights = blendWeights / (blendWeights.x + blendWeights.y + blendWeights.z);
  
  let colX = getGridColor(in.worldPos.zy);
  let colY = getGridColor(in.worldPos.xz);
  let colZ = getGridColor(in.worldPos.xy);
  
  let triplanarColor = colX * blendWeights.x + colY * blendWeights.y + colZ * blendWeights.z;
  let baseColor = triplanarColor * in.color;

  let lit = baseColor * (ambient + diffuse * 0.7);

  let dist = length(in.worldPos - u.cameraPos);
  let fogFactor = clamp(1.0 - exp(-dist * u.fogDensity), 0.0, 1.0);
  let finalColor = mix(lit, skyColor, fogFactor);

  return vec4<f32>(finalColor, 1.0);
}
`;
