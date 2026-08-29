export const CHUNK_SX = 16;
export const CHUNK_SY = 40;
export const CHUNK_SZ = 16;
export const WORLD_CHUNKS = 6; // grid WORLD_CHUNKS x WORLD_CHUNKS (mode benchmark, dunia tetap)

// Roadmap A.1 -- radius chunk streaming (infinite terrain), dalam satuan
// chunk (bukan voxel). Mulai kecil dulu sesuai anjuran roadmap sebelum
// dibesarkan; (2*r+1)^2 = jumlah chunk yang akan loaded sekaligus.
export const DEFAULT_VIEW_DISTANCE = 5;

// Roadmap B.4 -- radius (chunk, Chebyshev) dari pemain yang masih dapat
// storage SDF PENUH ('sdf', Float32). Di luar radius ini (tapi masih dalam
// DEFAULT_VIEW_DISTANCE) dipakai 'sdf-compact' (Int16, setengah memori --
// lihat QuantizedSDFStorage.js) karena kecil kemungkinan chunk sejauh itu
// diedit dalam waktu dekat, dan presisinya (1/512) tetap jauh lebih halus
// dari kebutuhan visual pada jarak render itu. HARUS lebih kecil dari
// DEFAULT_VIEW_DISTANCE (kalau >=, semua chunk akan selalu dapat storage
// penuh, fitur ini jadi tidak berpengaruh apapun).
export const DEFAULT_NEAR_STORAGE_RADIUS = 2;

// Roadmap A.5 -- Origin Rebasing: jarak (dalam chunk, Chebyshev) dari
// origin saat ini yang memicu rebase (lihat OriginRebase.js). Dipilih jauh
// lebih besar dari DEFAULT_VIEW_DISTANCE supaya rebase (yang memicu remesh
// SEMUA chunk loaded) jarang terjadi selama gameplay normal, tapi tetap
// jauh lebih kecil dari ambang presisi float32 (~100.000 unit, lihat
// acceptance test roadmap) supaya angka yang dibakar ke vertex buffer
// tetap sangat aman kapan pun.
export const DEFAULT_REBASE_THRESHOLD_CHUNKS = 32;

// Hardening A.5 -- setOriginChunk()/setDebugChunkBounds() menandai SEMUA
// chunk loaded dirty sekaligus. Untuk mesher 'surfacenets' (SINKRON --
// dipakai jalur SDF/Infinite Terrain), remeshDirtyChunks() tanpa budget
// akan membangun ulang SEMUA chunk itu dalam SATU frame -- ini frame hitch
// yang nyata dan tumbuh sebanding dengan view distance (setiap rebase,
// yang terjadi tiap ~DEFAULT_REBASE_THRESHOLD_CHUNKS chunk perjalanan).
// Nilai ini membatasi berapa BANYAK chunk boleh di-remesh per frame saat
// streaming aktif -- sisanya tetap dirty dan diproses di frame berikutnya
// (nearest-first, lihat remeshDirtyChunks() di VoxelEngine.js), menyebar
// biaya rebase ke banyak frame alih-alih satu lonjakan. Dipilih moderat:
// cukup besar supaya backlog dirty tidak menumpuk tak terbatas saat
// streaming aktif normal (chunk baru dari radius juga lewat jalur ini),
// cukup kecil supaya tidak ada frame yang harus remesh puluhan chunk
// sekaligus.
export const DEFAULT_REMESH_BUDGET_PER_FRAME = 4;

// Hotfix Hardening A.5 -- lihat catatan lengkap di
// VoxelEngine.remeshDirtyChunks(). DEFAULT_REMESH_BUDGET_PER_FRAME
// (angka TETAP) terbukti bisa menyebabkan starvation: chunk di cincin
// luar radius streaming bisa tidak pernah kebagian giliran remesh selama
// pemain terus berjalan (chunk baru yang lebih dekat selalu menang
// prioritas). Konstanta ini membatasi berapa BANYAK FRAME backlog dirty
// boleh menumpuk sebelum budget per-frame membesar otomatis untuk
// mengejarnya -- lihat main.js (Fase 5 render loop) untuk kalkulasinya:
// `budget = max(DEFAULT_REMESH_BUDGET_PER_FRAME, ceil(dirtyCount / ini))`.
// Menjamin backlog SELALU habis dalam <= nilai ini frame, apapun ukuran
// backlog-nya, sambil tetap kecil (DEFAULT_REMESH_BUDGET_PER_FRAME) saat
// backlog memang kecil.
export const DEFAULT_MAX_FRAMES_TO_CLEAR_REMESH_BACKLOG = 8;
