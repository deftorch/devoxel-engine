# Devoxel Engine Skills & Capabilities

## Kapan Dipakai
Dokumen ini menjadi rujukan teknis untuk agen AI yang diminta untuk menambah fitur, membangun aset, atau memperbaiki sistem di dalam Devoxel Engine.

## Kapabilitas
- **Render Voxel Kinerja Tinggi**: Menggunakan WebGPU untuk merender ribuan instance kubus dengan teknik *Greedy Meshing*.
- **Arsitektur Berbasis ECS**: Menggunakan `bitecs` dengan alokasi *TypedArray* pradefinisi (`growableComponent`) untuk mencegah kebocoran memori.
- **Multithreading**: Pembuatan chunk dan meshing dilakukan secara *asynchronous* melalui Web Workers.
- **CommandBus API**: Siap diintegrasikan dengan WebSocket/MCP Server untuk modifikasi state jarak jauh.

## Batasan (Constraints)
- **TIDAK BISA** menggunakan DOM/HTML secara langsung di dalam worker.
- **TIDAK BOLEH** menyimpan objek JS berat (seperti Mesh/Buffer WebGPU) di dalam komponen TypedArray ECS biasa. Gunakan komponen AoS khusus (contoh: `RenderMesh`).
- **Dimensi Chunk Default**: 16 blok (X) × 40 blok (Y) × 16 blok (Z). Sumbu Y adalah vertikal.

## Input yang Dibutuhkan untuk Aksi
- Menambahkan Tipe Blok: Anda harus memodifikasi registry di `src/data/blocks.js`.
- Modifikasi State: Anda harus menggunakan `CommandBus` via `window.devoxelAPI.execute(command, payload)`.
