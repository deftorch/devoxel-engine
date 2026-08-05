## **Gaya Permukaan — Blocky vs Smooth**

Ini pembeda paling kentara secara visual:

- **Cubic/blocky** (gaya Minecraft) — voxel dirender apa adanya sebagai kubus.Noa, Divine Engine semua di sini.
- **Smooth isosurface** — voxel cuma menyimpan _nilai density/jarak_, lalu diekstrak jadi permukaan halus lewat algoritma seperti Marching Cubes atau Dual Contouring. Marching Cubes adalah metode kubik original — masih dipakai luas meski sudah tua, sedangkan Dual Contouring adalah kombinasi lebih baru antara metode kubik dan dual, plus bisa digeneralisasi ke octree.

## **Algoritma Ekstraksi Permukaan (untuk yang smooth)**

Ini sendiri sub-klasifikasi besar, karena ada banyak sekali metode ekstraksi isosurface dari grid voxel atau fungsi implisit, disusun kira-kira berurutan waktu pengembangan:

| Metode              | Ciri                                                       | Trade-off                                                                   |
| ------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| Marching Cubes      | Vertex di tepi kubus                                       | Sulit menangkap sudut tajam karena vertex selalu nempel di lattice tetap    |
| Surface Nets        | Metode "dual" paling awal                                  | Untuk geometri kompleks, lebih cepat & mesh lebih kecil dari Marching Cubes |
| Dual Contouring     | Bisa menangkap sudut tajam, tapi tidak bisa didiferensiasi | Butuh data Hermite, lebih rumit diimplementasi                              |
| Dual Marching Cubes | Gabungkan kelebihan MC dan DC                              | Kompleksitas lebih tinggi                                                   |
| Neural MC/DC        | Versi berbasis deep learning dari MC/DC                    | Riset terbaru, belum matang untuk real-time                                 |

Menariknya, ada catatan penting soal masa depan metode ini: sejak hardware grafis sanggup ray-cast isosurface langsung tanpa konversi ke poligon, minat riset ke metode ekstraksi poligon jadi menurun drastis dalam dekade terakhir — ini pengamatan yang persis konsisten dengan "Jalur 2" (raymarching) yang kita bahas kemarin.

## **Struktur Data Penyimpanan — Ini Paling Banyak Variasinya**

Ada beberapa cara mendasar membagi ruang: grid biasa (setiap voxel ukuran sama), rectilinear grid (border per-dimensi bisa beda), nested grid (tiap level resolusi bisa beda-beda), octree (subdivisi 8 arah sampai voxel tunggal), BSP tree (subdivisi 1 dimensi per waktu), dan BVH (pakai objek geometris dasar). Riset terbaru menambah lebih banyak lagi:

- **Flat grid** — proyekmu, paling sederhana, `O(1)` akses tapi memori `O(n³)`.
- **Octree** — merepresentasikan bentuk sembarang dan mengompresi data dengan memakai voxel sebesar mungkin untuk area homogen. Dipakai VoxelPlugin.
- **Brickmap/Grid hierarchy** — grid flat di berbagai resolusi bertingkat; level resolusi rendah cuma simpan 1 bit penanda ada-tidaknya voxel di level bawahnya, sehingga bisa skip ruang kosong besar tanpa pointer sama sekali, jauh lebih cepat dari octree. Ini yang dibuktikan menang di benchmark VoxelRT kemarin.
- **Sparse Voxel DAG (SVDAG)** — menggeneralisasi tree jadi directed acyclic graph, sehingga region identik bisa berbagi pointer yang sama; di semua scene yang diuji, jumlah node berkurang 1-3 orde magnitudo dibanding SVO biasa. Ini dasar HashDAG yang kita bahas.
- **64-tree/"contree"** — generalisasi tree bercabang 64 (bukan 8), lahir dari observasi bahwa SVO klasik ternyata performanya lebih buruk 60% dibanding metode grid hierarkis yang lebih sederhana di beberapa benchmark. Ini teknik di balik "Tree64" VoxelRT.
- **Voxel SDF** — tiap voxel udara menyimpan jarak ke voxel solid terdekat; ini struktur data tercepat untuk ray tracing karena cuma butuh 1 lookup per langkah DDA, tapi mahal untuk update/edit real-time.

Kesimpulan sang penulis riset ini sangat relevan: struktur data terbaik biasanya kombinasi beberapa struktur sekaligus, bukan satu struktur murni — persis kenapa VoxelRT membandingkan begitu banyak varian, bukan mendeklarasikan satu "pemenang mutlak".

## **Lokasi Komputasi**

Ini yang sudah kita bahas panjang lebar minggu ini — spektrum dari main-thread murni (noa) → worker pool CPU paralel (proyekmu) → SharedArrayBuffer+Atomics multi-worker (Divine) → GPU compute shader (Fase 6-mu, omar-owis) → GPU raymarching penuh tanpa mesh (VoxelRT, Octo).

## **Cara Merepresentasikan "Isi" Voxel**

- **Boolean/okupansi** — solid atau kosong saja (proyekmu, bitmask).
- **Palet material** — 1 byte indeks ke tabel material (Teardown).
- **Density/SDF kontinu** — nilai float untuk permukaan halus (smooth terrain).
- **Multi-atribut** — warna, suhu, kepadatan sekaligus (VFX simulasi asap/api, medical imaging).

---

**Kenapa ini penting buatmu:** enam sumbu ini **independen satu sama lain** — itulah sumber ledakan variasi pendekatan yang kamu tanyakan.

optimisasi bukan satu skala linear "makin canggih makin bagus", tapi **suatu pendekatan punya masalah berbeda**, dan tiap engine yang sudah kita bongkar pilih kombinasi berbeda tergantung mana yang jadi bottleneck mereka. Mari saya klasifikasikan.

## **Kenapa Optimisasi Voxel Beda dari Optimisasi Grafis Biasa**

Di voxel engine dan game gaya-Minecraft, ada 2 bottleneck utama untuk GPU: penggunaan memori untuk mesh/voxel yang di-generate, dan kepadatan geometri. Karena voxel itu 3-dimensi dan membesar secara O(n³) begitu draw distance dinaikkan, RAM akan penuh sangat cepat — bahkan dengan culling sekalipun, kamu tetap harus generate mesh-nya dulu supaya siap digambar. Ini akar kenapa optimisasi voxel butuh begitu banyak pendekatan berlapis, bukan satu trik ajaib.

## **Optimisasi Meshing (mengurangi jumlah geometri)**

punya banyak varian:

- **Face/culled meshing** — cuma render wajah yang bersentuhan udara (dasar, sudah kamu punya).
- **Greedy meshing** — gabungkan wajah sejenis jadi quad besar. Reduksi vertex 80-90% dibanding meshing naif, 50-200 mikrodetik per chunk di implementasi GPU modern.
- **Vertex packing** (Vercidium) — bukan kurangi jumlah geometri, tapi kurangi _ukuran_ tiap vertex (1 integer per vertex).
- **Run-merging non-greedy** — trade-off sengaja terima lebih banyak triangle demi kecepatan build (teknik Vercidium, 390% lebih cepat, 20% lebih banyak tris).

**Insight penting:** ini semua optimisasi _bandwidth ke GPU dan waktu build_, bukan optimisasi runtime rendering — bedanya penting karena masalahnya beda (CPU/GPU sibuk generate vs GPU sibuk gambar).

## **Optimisasi Culling (jangan proses yang tak terlihat)**

Ini sendiri punya sub-klasifikasi yang sering disamakan padahal beda:

- **Frustum culling** — buang yang di luar field-of-view kamera (proyekmu belum punya, sudah direncanakan).
- **Distance/fog culling** — cylindrical fog culling, buang berdasarkan jarak murni.
- **Occlusion culling berbasis graph** — Minecraft ternyata tidak pakai frustum culling sederhana; ada developer Mojang yang menulis pendekatan visibility berbasis graph — cek konektivitas antar-chunk lewat "portal" (bisa lihat chunk B dari chunk A lewat sisi mana), bukan geometris murni. Ini yang disebut "Sodium-style graph-based visibility" — bersama frustum culling menangani 95%+ kasus occlusion voxel-world, sehingga Hi-Z occlusion (metode GPU lebih berat) baru dibutuhkan untuk kasus sisanya.
- **Hierarchical Z-buffer (Hi-Z) occlusion** — metode GPU murni, cek kedalaman terhadap buffer depth yang sudah di-downsample; lebih akurat tapi lebih mahal, biasanya cuma dipakai kalau graph-based belum cukup.

## **Optimisasi LOD — Ternyata Bukan Cuma "Downsample Voxel"**

Ini yang paling mengejutkan setelah saya gali: LOD voxel bisa berarti **algoritma rendering yang benar-benar berbeda** per jarak, bukan cuma resolusi diturunkan. Contoh nyata dari engine "Ascendant" (Vulkan): engine ini punya 5 sistem geometry draw berbeda — near-field pakai mesh SurfaceNets yang di-smooth (tidak lagi grid, jadi kehilangan sebagian optimisasi grid), sementara far-field balik ke voxel kubus murni karena lebih mudah dioptimalkan di jarak jauh. Jadi LOD-nya bukan "chunk yang sama, resolusi lebih rendah" — tapi "algoritma render yang beda total tergantung jarak". Proyekmu sekarang pakai pendekatan **ring-based dengan downsample** (lebih sederhana, satu algoritma konsisten) — sah-sah saja, tapi ini bukti bahwa "LOD" sendiri adalah sumbu dengan spektrum luas.

## **Optimisasi Memori/Kompresi**

- **Palet material 8-bit** (Teardown) — 1 byte per voxel.
- **Bitmask okupansi** (proyekmu) — 1 bit per voxel untuk solid/kosong.
- **RLE** — kompresi run untuk area seragam panjang.
- **Deduplikasi via DAG** — region identik berbagi pointer yang sama, mengurangi jumlah node 1-3 orde magnitudo.
- **Vertex pooling** — fixed-size bucket allocator di satu GPU buffer, alokasi/pelepasan O(1), dengan eviction prioritas berdasar jarak dan biaya vertex — ini optimisasi memori runtime, bukan kompresi data mentah.

## **Optimisasi Concurrency/Threading**

Transferable (proyekmu) → SharedArrayBuffer+Atomics (Divine) → lock-free multithreading (omar-owis, dengan triple-buffering: command buffer dibagi 3 region berotasi supaya CPU update satu segmen sementara GPU pakai dua lainnya, menghilangkan konflik baca-tulis) → GPU compute penuh.

## **Optimisasi Draw Call/Submission (sering terlewat\!)**

single-buffer indirect draws — semua draw command di satu GPUBuffer, dan AZDO rendering (Approaching Zero Driver Overhead): persistent mapped buffers, multi-draw indirect, direct state access — supaya draw call dan trafik memori seminimal mungkin. Ini optimisasi di level _bagaimana kamu bicara ke GPU driver_, terpisah total dari optimisasi geometri/data.

## **Voxel Ambient Occlusion (AO)**

Ini beda dari "gaya blocky vs smooth" yang sudah dibahas — ini soal shading permukaan blocky itu sendiri. Idenya: tiap vertex quad dicek 3 neighbor voxel-nya (2 sisi \+ 1 sudut), lalu dihitung nilai 0-3 yang menentukan seberapa gelap sudut itu dengan menggabungkan facet yang punya nilai ambient occlusion sama di semua vertex-nya. Beberapa sumber malah bilang ini **prasyarat visual**, bukan sekadar polish: ambient occlusion hampir jadi keharusan untuk game voxel, dan tanpa depth cue dari shading lembut ini, tidak ada cara membedakan ketinggian medan secara visual.

Yang menarik: AO ini **berinteraksi langsung dengan greedy meshing** milik proyekmu — kamu tidak bisa menggabungkan sembarang wajah sejenis lagi, hanya facet dengan nilai AO yang sama di semua vertex yang boleh digabung, jadi ini bukan fitur independen, tapi constraint tambahan ke algoritma yang sudah kamu punya. Beberapa engine bahkan pertimbangkan trade-off ini serius: implementasi AO memperlambat meshing dan menurunkan efisiensi greedy meshing, tapi efeknya sepadan.

## **Voxel editing / block placement**

Sebelumnya kan kita hanay berfokus ke _generate_ dan _render_, tapi tidak menyebut bagaimana pemain **mengubah** dunia (break/place block) — padahal ini definisi genre "voxel game" yang biasa. Teknik standarnya: **raycast DDA (Digital Differential Analyzer / Amanatides–Woo)** dari kamera menembus grid voxel untuk menemukan voxel target. DDA yang diadaptasi ke 3D itu persis yang dibutuhkan untuk menelusuri garis lurus lewat grid voxel, dan algoritma klasiknya dijelaskan di paper "A Fast Voxel Traversal Algorithm for Ray Tracing" (Amanatides & Woo 1987).

## **Konsekuensi edit voxel: dirty chunk \+ re-mesh \+ border stitching**

Kalau kamu tambah fitur edit di atas, otomatis muncul 3 masalah turunan yang juga tidak dibahas riset kamu:

- **Chunk dirty-flagging** — chunk yang diedit perlu ditandai untuk di-mesh ulang, bukan generate ulang dari nol.
- **Border/neighbor sampling** — greedy mesher butuh baca voxel di chunk tetangga supaya wajah di perbatasan chunk tidak bolong atau dobel. Proyekmu contoh library `binary-greedy-meshing` memasukkan data edge duplikat dari chunk tetangga yang dipakai untuk visibility culling dan AO — pola yang sama juga perlu kalau proyekmu nanti scaling ke banyak chunk yang saling terpisah worker.

## **Physics/collision voxel**

Collision detection ini komponen inti untuk gameplay non-flying-camera. Contoh nyata dari proyek voxel lain: sistem AABB Swept Collision untuk interaksi dengan dunia voxel, plus interaksi real-time penghancuran/penempatan blok.

## **Persistence / serialisasi dunia ke disk**

bagaimana dunia voxel (setelah diedit pemain) disimpan permanen — format region file (ala Minecraft "Anvil"), kompresi RLE per-chunk untuk disk, atau di web-context: IndexedDB. Ini beda dari "struktur data di memori" — ini soal _at-rest storage_.

## **Packing data vertex jadi integer tunggal**

sekarang pakai 9 float per vertex (`interleave` — posisi+normal+warna semua Float32). Teknik lanjutan yang dipakai engine production benar-benar mengompresi semuanya jadi **1-2 uint32 per vertex** — uint kedua berisi posisi Y vertex, ID tekstur, dan nilai ambient occlusion, semuanya di-pack jadi bit-bit dalam satu integer. Ini optimisasi bandwidth GPU yang jauh lebih agresif dari yang disinggung riset kamu.

## **Lighting propagation (beda dari AO)**

AO itu shading statis berbasis geometri sekitar, tapi **light propagation** (misal torch light menyebar lewat flood-fill BFS antar voxel, seperti sunlight/blocklight Minecraft) itu topik terpisah yang tidak disinggung sama sekali — padahal ini yang biasanya jadi motivasi kenapa engine butuh "smooth lighting" penuh, bukan cuma AO.

**Jenis noise**

Kode kamu (`hash2` \+ interpolasi bilinear \+ `smooth`) itu **value noise**, bukan Perlin atau Simplex noise walau hasilnya mirip. Bedanya:

- **Value noise** (punyamu): interpolasi antar nilai random di titik grid → cenderung ada artefak "blocky" di sudut grid kalau tidak di-smooth dengan hati-hati.
- **Perlin noise**: interpolasi antar _gradient vector_ di titik grid, bukan nilai langsung → lebih halus secara alami.
- **Simplex noise**: versi lebih baik dari Perlin noise, dirancang agar seamless dan lebih murah dihitung di dimensi tinggi.
- **Worley/cellular noise**: berbasis jarak ke titik-titik acak terdekat — dipakai untuk pola sel, retakan batu, atau biome dengan batas tegas (bukan gradien halus).

Ini bukan cuma soal istilah — pilihan noise mempengaruhi _karakter visual_ medan yang dihasilkan.

## **Heightmap 2D vs density field 3D**

Ini yang membedakan p"voxel engine sungguhan" ala Minecraft. Kode kamu murni fungsi `f(x,z) = y` — karena sifatnya fungsional, tidak mungkin ada dua nilai y di satu koordinat (x,z) yang sama, sehingga mustahil membuat gua, overhang, atau formasi kompleks 3D dengan pendekatan ini. Solusinya pakai **noise 3D sebagai fungsi density/SDF**: tinggi medan dari noise Perlin 2D, sementara gua dihasilkan dari noise 3D dengan konsep yang sama. Sumber lain menjelaskan pola generatornya: gradien diterapkan sepanjang sumbu tinggi sehingga volume jadi udara semakin ke atas dan menutup jadi materi padat semakin ke bawah — baseline density 3D yang lalu dimodifikasi noise.

Proyekmu tidak akan pernah bisa punya gua atau batu menggantung tanpa ganti dari heightmap ke pendekatan density 3D.

## **Multi-noise biome system**

Kode kamu cuma 1 noise map → 1 nilai tinggi → 1 jenis medan (grass/dirt/stone seragam di seluruh dunia). Minecraft 1.18+ pakai **beberapa noise map independen yang di-kombinasikan lewat spline**: tiga noise map 2D dipetakan lewat spline untuk menghitung offset tinggi dan faktor peregangan vertikal, dan noise yang sama juga dipakai untuk biome generation, menciptakan hubungan lembut antara biome dan bentuk medan. Parameternya:

- **Continentalness** — naik semakin ke daratan; nilai rendah menghasilkan lautan
- **Erosion** — menentukan seberapa datar/bergunung medan; nilai tinggi \= datar, nilai rendah \= bergunung
- **Peaks & Valleys (PV)**, **Temperature**, **Humidity**, **Weirdness** — temperature dan humidity dipakai memilih biome spesifik setelah area dikategorikan dulu berdasar continentalness dan erosion

Ini kenapa dunia Minecraft punya gurun, gunung, dataran, rawa — bukan medan seragam seperti proyekmu.

## **Erosion simulation — mengubah noise mentah jadi terlihat "alami"**

Noise fBm mentah (seperti punyamu) menghasilkan medan yang matematis halus tapi tidak terasa seperti tanah asli. Teknik **hydraulic erosion** mensimulasikan tetes air yang mengalir menuruni medan: air mengalir dari titik tinggi ke rendah, membawa sedimen menuruni bukit, lalu mengendapkan sedimen di area datar di mana aliran air melambat. Ada dua pendekatan: berbasis heightmap (seluruh grid diproses sekaligus) atau berbasis partikel (tiap tetes disimulasikan sebagai entitas individual yang bergerak melintasi medan). Bahkan bisa dipercepat drastis di GPU — simulasi 1 juta tetes air paralel lewat compute shader hanya makan waktu sekitar 10 detik. Ini yang menghasilkan pola lembah sungai dan punggung bukit yang realistis, sesuatu yang tidak akan pernah muncul dari fBm murni.

## **Noise caves (3 varian, bukan 1 rumus)**

Terkait poin 2, Minecraft modern spesifik punya 3 jenis gua noise berbeda: spaghetti, cheese, dan noodle caves, semua dari noise Perlin 3D dengan tiga parameter — frekuensi, hollowness, dan thickness — bukan satu formula gua generik.

## **Structure/feature placement (pohon, ore, dll) — dan masalah cross-chunk-nya**

Proyekmu tidak menaruh apa pun di atas medan (tidak ada pohon meski ada `BLOCK.GRASS`). Kalau nanti mau nambah, ada masalah klasik yang perlu ditangani: karena generasi diproses per-chunk, menempatkan pohon itu rumit karena strukturnya bisa menjorok ke chunk tetangga yang belum tentu sudah digenerasi. Solusinya salah satu dari dua pola: mengeksploitasi determinisme prosedural untuk "menebak" di mana pohon akan tumbuh di chunk tetangga tanpa perlu men-generate seluruh chunk itu, atau memecah generasi jadi multi-pass dengan akses ke chunk tetangga yang sudah melewati pass sebelumnya. Untungnya, karena medan proyekmu berbasis heightmap murni, kamu bisa menghitung ulang fungsi tinggi di koordinat manapun yang dibutuhkan — jadi pola pertama relatif mudah diterapkan di sini.

## **7\. Seed / variasi dunia**

`hash2` di kode kamu deterministik tapi **hardcoded** — tidak ada parameter seed yang bisa diganti user untuk menghasilkan dunia yang berbeda setiap kali (Minecraft: ketik seed angka apapun → dunia unik). Menambah ini simpel — cukup offset koordinat masukan `hash2` dengan nilai seed — tapi belum ada di proyekmu.

## **Domain warping — trik murah untuk medan terasa lebih organik**

Teknik yang tidak disebut riset kamu sebelumnya: sebelum sample noise di `(x, z)`, geser dulu koordinatnya pakai noise lain — `noise(x + noise2(x,z)*k, z + noise2(x,z)*k)`. Ini membuat kontur medan berkelok tidak beraturan (bukan cuma naik-turun simetris seperti fBm murni), efeknya besar tapi biayanya cuma 1 sample noise tambahan.

## **Texturing**

Berikut peta lengkap pendekatan texturing di voxel engine, dari yang paling dekat dengan punyamu sampai paling canggih:

## **Vertex color / palette-based (punyamu, level "Teardown")**

Tiap voxel/block cuma referensi ke satu warna di palette kecil, tidak ada gambar tekstur sama sekali. Ini sengaja dipakai game seperti Teardown untuk voxel destructible — tekstur voxel sebenarnya adalah palette warna yang dirender sebagai gambar 1×256 piksel, dan developer yang menganalisisnya menyimpulkan lebih baik memakai vertex-color langsung daripada texture+UV map untuk kasus ini. Kelebihan: super murah, tidak butuh atlas, tidak ada masalah UV di greedy meshing. Kekurangan: tidak ada detail permukaan (retak batu, urat kayu, dll) — makanya kelihatan "plain".

## **Texture atlas \+ UV (gaya Minecraft klasik) — dan masalah bawaannya**

Tiap wajah block dikasih koordinat UV yang menunjuk ke petak kecil di dalam satu gambar besar (atlas). Ini yang paling umum dipakai game voxel lama, tapi punya masalah teknis nyata: **texture bleeding/tearing**. Karena greedy meshing kamu menggabungkan banyak wajah jadi 1 quad besar, UV-nya harus di-stretch, dan terjadi robekan di sepanjang garis triangle akibat rounding saat memetakan UV dari atlas. Masalah lain: mipmapping. Satu developer menceritakan solusinya: akhirnya berhenti pakai texture atlas sepenuhnya dan pindah ke Texture2DArray karena artefak bleeding mipmap yang mengganggu.

## **Texture array (Texture2DArray) — solusi modern pengganti atlas**

Alih-alih 1 gambar besar dengan UV pecahan, tiap jenis block dapat 1 "layer" utuh di array tekstur, dan shader tinggal index pakai integer (ID block), bukan UV pecahan. Ini menghilangkan masalah bleeding sama sekali karena tiap layer terisolasi penuh. Ini juga persis pola yang dipakai di implementasi greedy meshing produksi: ID tekstur dipakai sebagai index ke texture array berisi tekstur tiap block, dengan koordinat sample dihitung dari (u/8, v/8, ID_tekstur). Ini jalur upgrade paling natural dari pendekatan vertex-color kamu kalau nanti mau nambah tekstur gambar — kompatibel dengan greedy meshing tanpa perlu UV-stretch rumit (tinggal tambah faktor "berapa kali tekstur diulang" di quad besar).

## **Triplanar mapping — dipakai kalau kamu upgrade ke smooth terrain (SDF)**

Kalau nanti kamu ganti dari blocky ke smooth isosurface (seperti dibahas sebelumnya soal Marching Cubes/Surface Nets), UV konvensional jadi tidak berlaku karena permukaannya tidak beraturan. Solusinya: ambil 3 sample tekstur berbeda per vertex lalu blend berdasar weight yang ditentukan vektor normal — pada dasarnya tekstur di-tile di seluruh dunia dan diproyeksikan ke permukaan dari 3 arah sumbu. Kelebihannya besar: mesh vertex-nya cuma butuh atribut posisi dan normal saja, tidak perlu UV unwrapping sama sekali.

## **Texture splatting/blending — untuk transisi antar material yang halus**

Untuk smooth terrain yang materialnya bercampur di satu titik (misal rumput meleleh jadi tanah), triplanar sering digabung texture splatting: sampling butuh akses ke tekstur 4 material sekaligus lewat array texture, lalu weight-nya dinormalisasi supaya totalnya 1 sebelum di-blend. Pendekatan lain menyimpan langsung di data vertex: CUSTOM1.x berisi 4 indeks tekstur (masing-masing 1 byte), CUSTOM1.y berisi 4 weight-nya — persis seperti splatmap warna klasik, tapi tekstur bisa bervariasi per titik.

## **Volume/3D texture — index tekstur disimpan langsung di data voxel**

Alternatif dari splatting: tiap voxel dikasih index 8-bit yang menunjuk ke salah satu dari 256 tekstur — format paling simpel, tapi tidak bisa merepresentasikan gradien sehingga "pengecatan" antar material tidak ada falloff-nya. Trade-off dicatat eksplisit: kalau texturing memang harus jadi properti voxel itu sendiri, data voxel makin besar dan pemrosesan volumetriknya makin berat.

## **Procedural/noise-based texturing (tanpa gambar sama sekali)**

Bukan sample gambar, tapi hitung warna langsung di fragment shader pakai noise function (mirip `fbm` yang sudah kamu punya untuk terrain, tapi dipakai untuk variasi warna permukaan alih-alih ketinggian). Ini murah di memori (tidak ada file gambar) tapi lebih berat di GPU per-pixel. Cocok kalau kamu mau upgrade dari flat-color kamu tanpa harus bikin/load aset gambar sama sekali — cukup tambah 1 noise call di fragment shader WGSL kamu, misal untuk variasi warna rumput/batu biar tidak terlihat terlalu rata.

## **Normal maps — detail permukaan tanpa nambah geometri**

Terpisah dari warna, engine voxel block juga sering nambah normal map supaya permukaan flat terasa bertekstur secara pencahayaan: normal map pada block membuat permukaan datar terlihat lebih detail lewat interaksi dengan pencahayaan, dikombinasi filter point (bukan bilinear) untuk tampilan pixelated yang disengaja — estetika khas voxel game.

ternyata ada **dua pola berbeda** yang sering disebut sama-sama "hybrid voxel \+ traditional asset", dan keduanya menyelesaikan masalah yang berbeda. Saya breakdown keduanya.

## **Kenapa hybrid ini dibutuhkan sama sekali?**

Voxel murni punya kelemahan estetika yang diakui langsung oleh developer voxel engine berpengalaman: voxel tidak cocok untuk realisme, dan bisa terlihat tidak alami kalau dicampur dengan elemen non-voxel. Tapi kebalikannya juga benar — kalau **semua** hal (termasuk detail kecil seperti perabotan, tanaman, karakter) dipaksa jadi voxel, kamu kehilangan detail visual dan kelenturan animasi yang mesh tradisional (dengan skinning, UV presisi, normal map) tawarkan. Makanya hampir semua game voxel modern (termasuk Enshrouded) tidak murni satu jenis representasi — mereka membagi tugas.

## **Pola A: Prop mesh "menumpang" di atas terrain voxel (paling umum, paling murah)**

Ini yang paling sering dipakai praktis: **terrain/struktur besar tetap voxel** (untuk destructibility & editability), tapi **objek kecil (pohon, batu detail, perabotan, NPC) tetap mesh biasa** — tidak pernah dikonversi jadi voxel sama sekali. Mesh itu cuma ditempatkan (posisi \+ rotasi disesuaikan normal permukaan voxel di titik itu) lalu dirender berdampingan lewat pipeline rasterisasi normal.

Ini konsisten dengan apa yang dikonfirmasi soal Enshrouded — integrasi Substance Painter untuk texturing aset yang lebih tradisional — artinya prop-prop itu tetap punya UV map dan tekstur gambar konvensional (bukan voxel material index), cuma "hidup" di dunia yang secara struktural voxel.

**Kelebihan**: murah, kualitas visual mesh tetap penuh (animasi, normal map, dsb). **Kekurangan**: prop-nya tidak ikut hancur/berubah bentuk saat terrain di sekitarnya diedit — makanya biasanya dipakai untuk hal yang memang tidak perlu destructible (pohon, furniture kecil, NPC), bukan struktur bangunan besar.

## **Pola B: Voxelisasi penuh — mesh dikonversi jadi voxel supaya benar-benar menyatu**

Untuk struktur besar yang **harus** ikut destructible (rumah buatan tangan, formasi batu detail), mesh diauthor dulu di software 3D biasa, lalu **dikonversi/di-voxelize** jadi representasi voxel sebelum digabung ke dunia. Prosesnya:

- **Voxelisasi**: mengubah model mesh tradisional jadi versi voxel — salah satu alasan utamanya justru supaya mesh itu bisa dipakai di lingkungan yang berbasis voxel. Tools seperti GPU voxelizer mengambil mesh target, lalu isi opsi untuk "fill in volume" (padat) atau cuma permukaan luarnya saja — pilihan ini penting karena voxel butuh tahu apakah bagian dalam objek "padat" atau kosong untuk kebutuhan destruction/collision nanti.
- **Preservasi tekstur saat konversi**: tool voxelisasi modern seperti VOXIFY mendukung transfer warna berbasis UV map, meski ada catatan penting: modifier ini tidak bisa bekerja dengan material warna sederhana atau multi-material kecuali semua material & warna sudah di-bake dulu jadi satu tekstur gabungan. Ini titik gesekan nyata antara pipeline artis tradisional (banyak material terpisah) dan representasi voxel (butuh 1 sumber warna per voxel).

## **Sistem material voxel untuk hybrid — di sinilah kompleksitas teknis sesungguhnya**

Begitu prop sudah jadi voxel (Pola B) atau kamu punya terrain voxel dengan banyak jenis permukaan, kamu butuh sistem material yang lebih canggih dari `BLOCK_COLOR` sederhana di proyekmu:

- **Material index per voxel**: indeks material voxel disimpan sebagai integer, dipakai nanti sebagai atribut vertex kustom untuk me-render mesh hasil generate dengan tekstur yang benar.
- **Triplanar \+ blending untuk transisi mulus**: karena voxel hasil smooth meshing tidak punya UV natural, triplanar mapping dipakai untuk mengaplikasikan tekstur, dan untuk transisi mulus antar material voxel berbeda dipakai pendekatan mirip splat map. Tapi ini mahal: dengan 4 material, 3 sample planar per tekstur, dan 5 tekstur per material, itu 60 texture fetch per fragment — makanya perlu trik seperti nearest-sampling atau reduce detail untuk hardware lemah.
- **Batasan normal mapping di voxel mesh**: ini gotcha teknis yang sering luput — voxel mesh tidak punya tangent, jadi kamu tidak bisa pakai tangent-space normal map yang biasa dipakai di mesh prop tradisional. Ini beda perlakuan nyata antara render path voxel dan render path mesh biasa dalam satu scene hybrid — kadang perlu memilih antara "gradient normal" (dihitung dari density field, mahal tapi konsisten antar chunk) vs "mesh normal" (dihitung dari triangle, tapi tidak konsisten di perbatasan chunk).

## **Masalah tambahan khusus hybrid: LOD & seam antara area voxel resolusi berbeda**

Kalau terrain voxel-mu pakai LOD (resolusi lebih rendah untuk area jauh) sementara prop mesh presisi tinggi ditempatkan di dekat kamera, transisi antar level of detail itu sendiri jadi masalah dokumentasi yang jarang dibahas: seseorang yang mencari referensi teknis untuk transisi LOD voxel yang halus tidak menemukan info teknis memadai di internet, akhirnya mengembangkan solusinya sendiri berdasar insting — menunjukkan ini area yang bahkan developer voxel senior masih banyak trial-and-error, bukan resep baku.

---

## **Ringkasan praktis, dipetakan ke proyekmu**

| Pola                           | Kapan dipakai                                                         | Biaya                                                                                           |
| ------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **A: Mesh menumpang di voxel** | Pohon, furniture, NPC, dekorasi yang tidak perlu ikut hancur          | Murah — proyekmu tinggal tambah entity mesh biasa \+ snap ke `heightAt()` yang sudah kamu punya |
| **B: Voxelisasi penuh mesh**   | Struktur buatan tangan yang harus destructible menyatu dengan terrain | Mahal — butuh pipeline voxelizer \+ material-index system \+ triplanar shader baru              |

Untuk proyekmu yang masih di tahap awal (belum ada editing sama sekali), **Pola A jauh lebih masuk akal sebagai langkah berikutnya** — kamu sudah punya fungsi `heightAt(x,z)` yang bisa dipakai langsung untuk menempatkan mesh pohon/prop di atas permukaan terrain tanpa perlu sentuh sistem voxel-nya sama sekali. Pola B baru relevan kalau nanti kamu benar-benar mau fitur "bangun rumah dari mesh yang bisa dihancurkan blok demi blok" ala Enshrouded.

## **Lay of the Land — pendekatan "micro-voxel" \+ physics per-voxel, beda filosofi dari Enshrouded**

Ini game solo-dev (Tooley1998 / Southern Cross Interactive, rilis April 2026, dibangun di **Unreal Engine** dengan sistem voxel custom di atasnya). Menariknya, pendekatannya justru **berlawanan arah** dari Enshrouded yang kita bahas sebelumnya — bukan smooth isosurface, tapi tetap kubik/blocky, cuma voxel-nya dibuat **jauh lebih kecil** dari game voxel biasa. Berikut breakdown-nya:

## **1\. "True voxel" — bukan block besar seperti Minecraft, tapi kubus mikro**

Ulasan independen mencatat perbedaan intinya secara eksplisit: di game lain, dunia terdiri dari serangkaian block, sementara Lay of the Land memakai voxel sungguhan — kubus mini seukuran piksel yang menyatu membentuk dunia. Ini beda filosofi dari yang kita bahas soal Enshrouded (smooth isosurface lewat Marching Cubes/Dual Contouring). Lay of the Land tetap **kubik** (bukan permukaan halus hasil interpolasi), tapi resolusinya begitu tinggi sehingga bentuk lengkung (silinder, kerucut, atap miring) terlihat halus semata-mata karena ukuran kubusnya sangat kecil — pendekatan "brute-force resolution" alih-alih "algoritma isosurface pintar".

## **2\. Dua lapis grid: grid kasar untuk bangun cepat, grid halus untuk detail bebas**

Ini yang menjelaskan klaim marketing "tidak grid-locked" — sebenarnya ada 2 tingkat granularitas yang bekerja bersamaan:

- **Grid kasar (bulk placement)**: material bangunan bisa ditempatkan satu-satu atau dengan klik-drag untuk membangun bagian lebih besar sekaligus; saat ditempatkan, material otomatis mengunci ke grid dan mengisi ruang kosong tanpa menggantikan block yang sudah ada.
- **Grid halus (per-voxel carving)**: setelah material ditempatkan, pemain bisa menghapus voxel individual dengan tangan kosong untuk mengukir detail atau membuat bentuk yang lebih rumit dan unik.

Jadi "kebebasan"-nya bukan berarti tanpa grid sama sekali — tapi grid-nya jauh lebih halus dari 1 block \= 1 meter ala Minecraft, sehingga terasa bebas.

## **3\. Procedural shape tools — primitif matematis di-"cap" ke grid halus, bukan ditempatkan voxel demi voxel**

Ini fitur pembedanya paling dipuji reviewer: alih-alih menempatkan kotak persegi, pemain memakai sistem bentuk prosedural yang mendukung silinder, kerucut, atap miring, dan struktur organik kompleks. Developer sendiri mengonfirmasi UI-nya berevolusi jadi manipulasi langsung: sekarang kamu memanipulasi bentuk prosedural di dunia pakai gizmo, bukan lewat UI menu. Secara teknis, ini kemungkinan besar bekerja mirip operasi CSG (Constructive Solid Geometry) — kamu tentukan parameter bentuk (radius silinder, sudut kerucut), lalu engine me-rasterisasi bentuk matematis itu ke grid voxel halus secara otomatis (mirip voxelisasi mesh yang kita bahas sebelumnya, tapi sumbernya primitif geometris, bukan mesh hasil authoring).

## **4\. Fisika per-voxel yang benar-benar kontinu — bukan cuma saat destruksi**

Ini beda besar dari Teardown (yang fisika baru aktif saat voxel lepas dari cluster). Deskripsi resmi: setiap objek di dunia mematuhi simulasi fisika real-time secara terus-menerus — struktur runtuh di bawah beban, item bergelinding menuruni lereng, dan lingkungan bereaksi dinamis terhadap aksi pemain maupun combat, diterapkan sekaligus ke musuh, loot, dan terrain. Developer sendiri mengonfirmasi skala performanya: ribuan voxel bergerak sekarang bisa disimulasikan dengan sedikit kehilangan performa, termasuk fitur baru bisa terkubur di pasir. Ini menunjukkan mereka punya sistem physics-culling/sleeping agresif — tidak mungkin menjalankan rigid body penuh untuk semua voxel non-stop tanpa optimisasi semacam itu.

## **5\. Simulasi material per-voxel — bukan cuma ID block statis**

Ini ekstensi menarik dari pembahasan kita soal "isi voxel" sebelumnya (boolean/palette/density) — Lay of the Land nambah **state simulasi** per voxel: material seperti rumput akan berubah jadi abu saat terbakar, dan tiap jenis voxel punya laju bakar sendiri-sendiri — daun terbakar lebih cepat dari kayu. Ini pola cellular automaton berjalan di atas grid voxel (state: normal → terbakar → abu), bukan sekadar lookup warna statis seperti `BLOCK_COLOR` di proyekmu.

## **6\. Terrain generation berlapis — bukan cuma 1 fungsi noise**

Konsisten dengan pembahasan kita soal multi-noise (Minecraft-style continentalness/erosion), sistem mereka juga berlapis: generasi dunia prosedural memakai simulasi berlapis untuk menciptakan lanskap yang natural dengan nuansa hand-designed — air mengukir jalur lewat lembah sementara jalan berkelok menghubungkan lokasi secara organik. Ini mirip kombinasi hydraulic erosion simulation (yang kita bahas) \+ pathfinding/road-network generator berjalan di atas heightmap dasar.

## **7\. LOD untuk voxel mikro — tantangan lebih besar dari LOD blok besar**

Karena voxelnya super kecil, jumlah data mentah jauh lebih besar dari game voxel block-besar biasa, jadi LOD krusial. Developer memamerkan progres iteratif soal ini: "coba tebak transisi LOD-nya. Petunjuk: sekarang jauh lebih susah ditemukan" — menunjukkan mereka terus menghaluskan seam antar level detail (masalah yang sama persis dengan yang kita bahas soal LOD blending di Voxel Farm/dexyfex sebelumnya).

---

## **Ringkasan perbandingan 3 pendekatan yang sudah kita bahas**

|                | Proyekmu             | Enshrouded                            | Lay of the Land                                                      |
| -------------- | -------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| Ukuran voxel   | Block besar (1 unit) | Tidak dipublikasi, smooth mesh        | **Sangat kecil ("pixel-sized")**                                     |
| Gaya permukaan | Blocky tegas         | Smooth isosurface                     | **Blocky tapi halus karena resolusi tinggi**                         |
| Building       | Belum ada            | Sculpting kontinu                     | **Grid kasar (bulk) \+ grid halus (carving) \+ primitif prosedural** |
| Fisika         | Tidak ada            | "Fantastis" (anti-gravitasi struktur) | **Simulasi fisika penuh & kontinu per voxel**                        |
| Material       | Statis (warna saja)  | Tidak dipublikasi                     | **Dinamis (state terbakar/abu, laju bakar per jenis)**               |

Intinya: Lay of the Land membuktikan ada jalur ketiga di luar "blocky besar ala Minecraft" vs "smooth isosurface ala Enshrouded" — yaitu **tetap kubik, tapi voxel-nya dibuat sekecil mungkin** sehingga kelenturan bentuk didapat dari resolusi brute-force, dikombinasikan dengan physics simulation yang jauh lebih berat (karena tiap voxel berpotensi jadi entitas fisika independen) dibanding pendekatan lain yang kita bahas.
