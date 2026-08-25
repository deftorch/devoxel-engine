export const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec3 aPosition;
in vec3 aNormal;
in vec3 aColor;

uniform mat4 uViewProj;

out vec3 vNormal;
out vec3 vColor;
out vec3 vWorldPos;

void main() {
    gl_Position = uViewProj * vec4(aPosition, 1.0);
    vNormal = aNormal;
    vColor = aColor;
    vWorldPos = aPosition;
}
`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vColor;
in vec3 vWorldPos;

uniform vec3 uCameraPos;
uniform float uFogDensity;

out vec4 fragColor;

// Fungsi procedural texture grid sederhana
vec3 getGridColor(vec2 uv) {
    vec2 grid = fract(uv * 2.0); // Skala grid
    float line = step(0.95, grid.x) + step(0.95, grid.y);
    return mix(vec3(0.7), vec3(0.2, 0.6, 0.9), clamp(line, 0.0, 1.0));
}

void main() {
    vec3 lightDir = normalize(vec3(0.45, 0.85, 0.3));
    vec3 skyColor = vec3(0.53, 0.72, 0.86);
    vec3 groundAmbient = vec3(0.30, 0.27, 0.23);

    vec3 normal = normalize(vNormal);
    float hemi = clamp(normal.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 ambient = mix(groundAmbient, skyColor * 0.55, hemi);

    float diffuse = max(dot(normal, lightDir), 0.0);
    
    // --- Triplanar Mapping ---
    // Hitung bobot percampuran berdasar arah normal
    vec3 blendWeights = abs(normal);
    // Normalisasi bobot agar jumlahnya 1.0
    blendWeights = blendWeights / (blendWeights.x + blendWeights.y + blendWeights.z);
    
    // Sample texture/procedural dari 3 proyeksi planar
    vec3 colX = getGridColor(vWorldPos.zy);
    vec3 colY = getGridColor(vWorldPos.xz);
    vec3 colZ = getGridColor(vWorldPos.xy);
    
    // Blend warna berdasar bobot
    vec3 triplanarColor = colX * blendWeights.x + colY * blendWeights.y + colZ * blendWeights.z;
    // Campurkan dengan warna vertex dasar agar vColor (Splatting dasar) tetap berpengaruh
    vec3 baseColor = triplanarColor * vColor;

    vec3 lit = baseColor * (ambient + diffuse * 0.7);

    float dist = length(vWorldPos - uCameraPos);
    float fogFactor = clamp(1.0 - exp(-dist * uFogDensity), 0.0, 1.0);
    vec3 finalColor = mix(lit, skyColor, fogFactor);

    fragColor = vec4(finalColor, 1.0);
}
`;
