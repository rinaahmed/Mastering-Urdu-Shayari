// IndexedDB storage layer. All app state lives here; the API is stateless.

const DB_NAME = 'ls-db';   // v2 rewrite — fresh database
const DB_VERSION = 1;

export const STORES = {
  plans: 'plans',                     // key: id — imported plan files, verbatim
  nodes: 'nodes',                     // key: id — skill node ledger state
  errorCategories: 'errorCategories', // key: id
  artifacts: 'artifacts',             // key: id
  sessions: 'sessions',               // key: id
  lessonState: 'lessonState',         // key: id (lesson id) — completion gates
  queue: 'queue',                     // autoIncrement — pending API calls while offline
  meta: 'meta'                        // key: key — activePlanId, currentLessonId, einkMode, resolved missingData
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const mk = (name, opts, indexes = []) => {
        if (!db.objectStoreNames.contains(name)) {
          const s = db.createObjectStore(name, opts);
          indexes.forEach((ix) => s.createIndex(ix, ix));
        }
      };
      mk(STORES.plans, { keyPath: 'id' });
      mk(STORES.nodes, { keyPath: 'id' }, ['planId']);
      mk(STORES.errorCategories, { keyPath: 'id' }, ['planId']);
      mk(STORES.artifacts, { keyPath: 'id' }, ['planId', 'lessonId', 'date']);
      mk(STORES.sessions, { keyPath: 'id' }, ['planId', 'date', 'status']);
      mk(STORES.lessonState, { keyPath: 'id' }, ['planId']);
      mk(STORES.queue, { keyPath: 'id', autoIncrement: true });
      mk(STORES.meta, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(storeName, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    fn(t.objectStore(storeName));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const db = {
  async get(store, key) {
    const d = await openDb();
    return reqToPromise(d.transaction(store).objectStore(store).get(key));
  },
  async getAll(store) {
    const d = await openDb();
    return reqToPromise(d.transaction(store).objectStore(store).getAll());
  },
  async getAllByIndex(store, index, value) {
    const d = await openDb();
    return reqToPromise(d.transaction(store).objectStore(store).index(index).getAll(value));
  },
  async put(store, value) {
    await tx(store, 'readwrite', (s) => s.put(value));
    return value;
  },
  async putAll(store, values) {
    await tx(store, 'readwrite', (s) => values.forEach((v) => s.put(v)));
    return values;
  },
  async delete(store, key) {
    await tx(store, 'readwrite', (s) => s.delete(key));
  },
  async clear(store) {
    await tx(store, 'readwrite', (s) => s.clear());
  },
  async add(store, value) {
    const d = await openDb();
    const t = d.transaction(store, 'readwrite');
    return reqToPromise(t.objectStore(store).add(value));
  },

  async getMeta(key, fallback = null) {
    const row = await this.get(STORES.meta, key);
    return row ? row.value : fallback;
  },
  setMeta(key, value) {
    return this.put(STORES.meta, { key, value });
  }
};

export function uid(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Full export of every store — the data belongs to the user.
export async function exportAll() {
  const out = { exportedAt: new Date().toISOString(), app: 'learning-sessions', version: 2, stores: {} };
  for (const name of Object.values(STORES)) {
    out.stores[name] = await db.getAll(name);
  }
  return out;
}

export async function importAll(dump) {
  if (!dump || !dump.stores) throw new Error('Not a valid export file (missing "stores")');
  for (const name of Object.values(STORES)) {
    if (Array.isArray(dump.stores[name])) {
      await db.clear(name);
      await db.putAll(name, dump.stores[name]);
    }
  }
}
