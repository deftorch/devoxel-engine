export const CHUNK_SX = 16;
export const CHUNK_SY = 40;
export const CHUNK_SZ = 16;
export const WORLD_CHUNKS = 6; // grid WORLD_CHUNKS x WORLD_CHUNKS (mode benchmark, dunia tetap)

// Roadmap A.1 -- radius chunk streaming (infinite terrain), dalam satuan
// chunk (bukan voxel). Mulai kecil dulu sesuai anjuran roadmap sebelum
// dibesarkan; (2*r+1)^2 = jumlah chunk yang akan loaded sekaligus.
export const DEFAULT_VIEW_DISTANCE = 5;
