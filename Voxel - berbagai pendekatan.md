## **Gaya Permukaan — Blocky vs Smooth**

Ini pembeda paling kentara secara visual:

* **Cubic/blocky** (gaya Minecraft) — voxel dirender apa adanya sebagai kubus. Proyekmu, noa, Divine Engine semua di sini.  
* **Smooth isosurface** — voxel cuma menyimpan *nilai density/jarak*, lalu diekstrak jadi permukaan halus lewat algoritma seperti Marching Cubes atau Dual Contouring. Marching Cubes adalah metode kubik original — masih dipakai luas meski sudah tua, sedangkan Dual Contouring adalah kombinasi lebih baru antara metode kubik dan dual, plus bisa digeneralisasi ke octree.

## **Algoritma Ekstraksi Permukaan (untuk yang smooth)**

Ini sendiri sub-klasifikasi besar, karena ada banyak sekali metode ekstraksi isosurface dari grid voxel atau fungsi implisit, disusun kira-kira berurutan waktu pengembangan:

| Metode | Ciri | Trade-off |
| ----- | ----- | ----- |
| Marching Cubes | Vertex di tepi kubus | Sulit menangkap sudut tajam karena vertex selalu nempel di lattice tetap |
| Surface Nets | Metode "dual" paling awal | Untuk geometri kompleks, lebih cepat & mesh lebih kecil dari Marching Cubes |
| Dual Contouring | Bisa menangkap sudut tajam, tapi tidak bisa didiferensiasi | Butuh data Hermite, lebih rumit diimplementasi |
| Dual Marching Cubes | Gabungkan kelebihan MC dan DC | Kompleksitas lebih tinggi |
| Neural MC/DC | Versi berbasis deep learning dari MC/DC | Riset terbaru, belum matang untuk real-time |

Menariknya, ada catatan penting soal masa depan metode ini: sejak hardware grafis sanggup ray-cast isosurface langsung tanpa konversi ke poligon, minat riset ke metode ekstraksi poligon jadi menurun drastis dalam dekade terakhir — ini pengamatan yang persis konsisten dengan "Jalur 2" (raymarching) yang kita bahas kemarin.

## **Struktur Data Penyimpanan — Ini Paling Banyak Variasinya**

Ada beberapa cara mendasar membagi ruang: grid biasa (setiap voxel ukuran sama), rectilinear grid (border per-dimensi bisa beda), nested grid (tiap level resolusi bisa beda-beda), octree (subdivisi 8 arah sampai voxel tunggal), BSP tree (subdivisi 1 dimensi per waktu), dan BVH (pakai objek geometris dasar). Riset terbaru menambah lebih banyak lagi:

* **Flat grid** — proyekmu, paling sederhana, `O(1)` akses tapi memori `O(n³)`.  
* **Octree** — merepresentasikan bentuk sembarang dan mengompresi data dengan memakai voxel sebesar mungkin untuk area homogen. Dipakai VoxelPlugin.  
* **Brickmap/Grid hierarchy** — grid flat di berbagai resolusi bertingkat; level resolusi rendah cuma simpan 1 bit penanda ada-tidaknya voxel di level bawahnya, sehingga bisa skip ruang kosong besar tanpa pointer sama sekali, jauh lebih cepat dari octree. Ini yang dibuktikan menang di benchmark VoxelRT kemarin.  
* **Sparse Voxel DAG (SVDAG)** — menggeneralisasi tree jadi directed acyclic graph, sehingga region identik bisa berbagi pointer yang sama; di semua scene yang diuji, jumlah node berkurang 1-3 orde magnitudo dibanding SVO biasa. Ini dasar HashDAG yang kita bahas.  
* **64-tree/"contree"** — generalisasi tree bercabang 64 (bukan 8), lahir dari observasi bahwa SVO klasik ternyata performanya lebih buruk 60% dibanding metode grid hierarkis yang lebih sederhana di beberapa benchmark. Ini teknik di balik "Tree64" VoxelRT.  
* **Voxel SDF** — tiap voxel udara menyimpan jarak ke voxel solid terdekat; ini struktur data tercepat untuk ray tracing karena cuma butuh 1 lookup per langkah DDA, tapi mahal untuk update/edit real-time.

Kesimpulan sang penulis riset ini sangat relevan: struktur data terbaik biasanya kombinasi beberapa struktur sekaligus, bukan satu struktur murni — persis kenapa VoxelRT membandingkan begitu banyak varian, bukan mendeklarasikan satu "pemenang mutlak".

## **Lokasi Komputasi**

Ini yang sudah kita bahas panjang lebar minggu ini — spektrum dari main-thread murni (noa) → worker pool CPU paralel (proyekmu) → SharedArrayBuffer+Atomics multi-worker (Divine) → GPU compute shader (Fase 6-mu, omar-owis) → GPU raymarching penuh tanpa mesh (VoxelRT, Octo).

## **Cara Merepresentasikan "Isi" Voxel**

* **Boolean/okupansi** — solid atau kosong saja (proyekmu, bitmask).  
* **Palet material** — 1 byte indeks ke tabel material (Teardown).  
* **Density/SDF kontinu** — nilai float untuk permukaan halus (smooth terrain).  
* **Multi-atribut** — warna, suhu, kepadatan sekaligus (VFX simulasi asap/api, medical imaging).

---

**Kenapa ini penting buatmu:** enam sumbu ini **independen satu sama lain** — itulah sumber ledakan variasi pendekatan yang kamu tanyakan.

optimisasi bukan satu skala linear "makin canggih makin bagus", tapi **suatu pendekatan punya masalah berbeda**, dan tiap engine yang sudah kita bongkar pilih kombinasi berbeda tergantung mana yang jadi bottleneck mereka. Mari saya klasifikasikan.

## **Kenapa Optimisasi Voxel Beda dari Optimisasi Grafis Biasa**

Di voxel engine dan game gaya-Minecraft, ada 2 bottleneck utama untuk GPU: penggunaan memori untuk mesh/voxel yang di-generate, dan kepadatan geometri. Karena voxel itu 3-dimensi dan membesar secara O(n³) begitu draw distance dinaikkan, RAM akan penuh sangat cepat — bahkan dengan culling sekalipun, kamu tetap harus generate mesh-nya dulu supaya siap digambar. Ini akar kenapa optimisasi voxel butuh begitu banyak pendekatan berlapis, bukan satu trik ajaib.

## **Optimisasi Meshing (mengurangi jumlah geometri)**

punya banyak varian:

* **Face/culled meshing** — cuma render wajah yang bersentuhan udara (dasar, sudah kamu punya).  
* **Greedy meshing** — gabungkan wajah sejenis jadi quad besar. Reduksi vertex 80-90% dibanding meshing naif, 50-200 mikrodetik per chunk di implementasi GPU modern.  
* **Vertex packing** (Vercidium) — bukan kurangi jumlah geometri, tapi kurangi *ukuran* tiap vertex (1 integer per vertex).  
* **Run-merging non-greedy** — trade-off sengaja terima lebih banyak triangle demi kecepatan build (teknik Vercidium, 390% lebih cepat, 20% lebih banyak tris).

**Insight penting:** ini semua optimisasi *bandwidth ke GPU dan waktu build*, bukan optimisasi runtime rendering — bedanya penting karena masalahnya beda (CPU/GPU sibuk generate vs GPU sibuk gambar).

## **Optimisasi Culling (jangan proses yang tak terlihat)**

Ini sendiri punya sub-klasifikasi yang sering disamakan padahal beda:

* **Frustum culling** — buang yang di luar field-of-view kamera (proyekmu belum punya, sudah direncanakan).  
* **Distance/fog culling** — cylindrical fog culling, buang berdasarkan jarak murni.  
* **Occlusion culling berbasis graph** — Minecraft ternyata tidak pakai frustum culling sederhana; ada developer Mojang yang menulis pendekatan visibility berbasis graph — cek konektivitas antar-chunk lewat "portal" (bisa lihat chunk B dari chunk A lewat sisi mana), bukan geometris murni. Ini yang disebut "Sodium-style graph-based visibility" — bersama frustum culling menangani 95%+ kasus occlusion voxel-world, sehingga Hi-Z occlusion (metode GPU lebih berat) baru dibutuhkan untuk kasus sisanya.  
* **Hierarchical Z-buffer (Hi-Z) occlusion** — metode GPU murni, cek kedalaman terhadap buffer depth yang sudah di-downsample; lebih akurat tapi lebih mahal, biasanya cuma dipakai kalau graph-based belum cukup.

## **Optimisasi LOD — Ternyata Bukan Cuma "Downsample Voxel"**

Ini yang paling mengejutkan setelah saya gali: LOD voxel bisa berarti **algoritma rendering yang benar-benar berbeda** per jarak, bukan cuma resolusi diturunkan. Contoh nyata dari engine "Ascendant" (Vulkan): engine ini punya 5 sistem geometry draw berbeda — near-field pakai mesh SurfaceNets yang di-smooth (tidak lagi grid, jadi kehilangan sebagian optimisasi grid), sementara far-field balik ke voxel kubus murni karena lebih mudah dioptimalkan di jarak jauh. Jadi LOD-nya bukan "chunk yang sama, resolusi lebih rendah" — tapi "algoritma render yang beda total tergantung jarak". Proyekmu sekarang pakai pendekatan **ring-based dengan downsample** (lebih sederhana, satu algoritma konsisten) — sah-sah saja, tapi ini bukti bahwa "LOD" sendiri adalah sumbu dengan spektrum luas.

## **Optimisasi Memori/Kompresi**

* **Palet material 8-bit** (Teardown) — 1 byte per voxel.  
* **Bitmask okupansi** (proyekmu) — 1 bit per voxel untuk solid/kosong.  
* **RLE** — kompresi run untuk area seragam panjang.  
* **Deduplikasi via DAG** — region identik berbagi pointer yang sama, mengurangi jumlah node 1-3 orde magnitudo.  
* **Vertex pooling** — fixed-size bucket allocator di satu GPU buffer, alokasi/pelepasan O(1), dengan eviction prioritas berdasar jarak dan biaya vertex — ini optimisasi memori runtime, bukan kompresi data mentah.

## **Optimisasi Concurrency/Threading**

Transferable (proyekmu) → SharedArrayBuffer+Atomics (Divine) → lock-free multithreading (omar-owis, dengan triple-buffering: command buffer dibagi 3 region berotasi supaya CPU update satu segmen sementara GPU pakai dua lainnya, menghilangkan konflik baca-tulis) → GPU compute penuh.

## **Optimisasi Draw Call/Submission (sering terlewat\!)**

single-buffer indirect draws — semua draw command di satu GPUBuffer, dan AZDO rendering (Approaching Zero Driver Overhead): persistent mapped buffers, multi-draw indirect, direct state access — supaya draw call dan trafik memori seminimal mungkin. Ini optimisasi di level *bagaimana kamu bicara ke GPU driver*, terpisah total dari optimisasi geometri/data.