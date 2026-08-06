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

@fragment
fn fs_main(in : VOut) -> @location(0) vec4<f32> {
  let lightDir = normalize(vec3<f32>(0.45, 0.85, 0.3));
  let skyColor = vec3<f32>(0.53, 0.72, 0.86);
  let groundAmbient = vec3<f32>(0.30, 0.27, 0.23);

  let hemi = clamp(normalize(in.normal).y * 0.5 + 0.5, 0.0, 1.0);
  let ambient = mix(groundAmbient, skyColor * 0.55, hemi);

  let diffuse = max(dot(normalize(in.normal), lightDir), 0.0);
  let lit = in.color * (ambient + diffuse * 0.7);

  let dist = length(in.worldPos - u.cameraPos);
  let fogFactor = clamp(1.0 - exp(-dist * u.fogDensity), 0.0, 1.0);
  let finalColor = mix(lit, skyColor, fogFactor);

  return vec4<f32>(finalColor, 1.0);
}
`;
