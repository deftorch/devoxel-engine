export const CHUNK_SX = 16;
export const CHUNK_SY = 40;
export const CHUNK_SZ = 16;
export const WORLD_CHUNKS = 6; // grid WORLD_CHUNKS x WORLD_CHUNKS (mode benchmark, dunia tetap)

// Roadmap A.1 -- radius chunk streaming (infinite terrain), dalam satuan
// chunk (bukan voxel). Mulai kecil dulu sesuai anjuran roadmap sebelum
// dibesarkan; (2*r+1)^2 = jumlah chunk yang akan loaded sekaligus.
export const DEFAULT_VIEW_DISTANCE = 5;

// Roadmap A.5 -- Origin Rebasing: jarak (dalam chunk, Chebyshev) dari
// origin saat ini yang memicu rebase (lihat OriginRebase.js). Dipilih jauh
// lebih besar dari DEFAULT_VIEW_DISTANCE supaya rebase (yang memicu remesh
// SEMUA chunk loaded) jarang terjadi selama gameplay normal, tapi tetap
// jauh lebih kecil dari ambang presisi float32 (~100.000 unit, lihat
// acceptance test roadmap) supaya angka yang dibakar ke vertex buffer
// tetap sangat aman kapan pun.
export const DEFAULT_REBASE_THRESHOLD_CHUNKS = 32;
