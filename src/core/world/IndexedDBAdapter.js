/**
 * IndexedDBAdapter — glue tipis untuk Roadmap A.3, TIDAK diuji lewat `node
 * --test` (IndexedDB cuma ada di browser, bukan Node) -- lihat
 * ChunkPersistenceStore.js untuk logic sesungguhnya yang testable, kelas
 * ini cuma menerjemahkan get/put/delete jadi panggilan IndexedDB API.
 *
 * IndexedDB dipilih (bukan localStorage) karena:
 *   - Mendukung structured clone LANGSUNG untuk typed array (Float32Array
 *     dari SDFStorage.serialize()) -- tidak perlu base64/JSON encode yang
 *     akan memperlambat & memperbesar ukuran simpanan secara signifikan.
 *   - Async by design, tidak memblokir main thread seperti localStorage.
 *   - Kapasitas jauh lebih besar dari batas ~5MB localStorage per-origin.
 */
export function createIndexedDBAdapter(dbName = 'devoxel-chunks', storeName = 'chunks') {
  if (typeof indexedDB === 'undefined') {
    throw new Error(
      '[IndexedDBAdapter] IndexedDB tidak tersedia di environment ini (bukan browser, ' +
        'atau storage dinonaktifkan). Cek `typeof indexedDB !== "undefined"` sebelum memanggil ini.'
    );
  }

  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(storeName)) {
          req.result.createObjectStore(storeName);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  return {
    async get(key) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    },
    async put(key, value) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
    async delete(key) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };
}
