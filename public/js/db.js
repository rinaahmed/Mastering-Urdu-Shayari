// IndexedDB storage layer. All app state lives here; the API is stateless.

const DB_NAME = 'mus-db';
const DB_VERSION = 1;

export const STORES = {
  plans: 'plans',                 // key: id — imported plan files, verbatim
  nodes: 'nodes',                 // key: id — skill node ledger state
  errorCategories: 'errorCategories', // key: id
  artifacts: 'artifacts',         // key: id
  sessions: 'sessions',           // key: id
  queue: 'queue',                 // autoIncrement — pending API calls while offline
  meta: 'meta'                    // key: key — activePlanId, currentLessonId, ...
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.plans)) db.createObjectStore(STORES.plans, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.nodes)) {
        const s = db.createObjectStore(STORES.nodes, { keyPath: 'id' });
        s.createIndex('planId', 'planId');
      }
      if (!db.objectStoreNames.contains(STORES.errorCategories)) {
        const s = db.createObjectStore(STORES.errorCategories, { keyPath: 'id' });
        s.createIndex('planId', 'planId');
      }
      if (!db.objectStoreNames.contains(STORES.artifacts)) {
        const s = db.createObjectStore(STORES.artifacts, { keyPath: 'id' });
        s.createIndex('planId', 'planId');
        s.createIndex('lessonId', 'lessonId');
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains(STORES.sessions)) {
        const s = db.createObjectStore(STORES.sessions, { keyPath: 'id' });
        s.createIndex('planId', 'planId');
        s.createIndex('date', 'date');
        s.createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains(STORES.queue)) db.createObjectStore(STORES.queue, { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains(STORES.meta)) db.createObjectStore(STORES.meta, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result && result._req ? result._req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
  put(store, value) {
    return tx(store, 'readwrite', (s) => { s.put(value); return value; });
  },
  putAll(store, values) {
    return tx(store, 'readwrite', (s) => { values.forEach((v) => s.put(v)); return values; });
  },
  delete(store, key) {
    return tx(store, 'readwrite', (s) => { s.delete(key); });
  },
  clear(store) {
    return tx(store, 'readwrite', (s) => { s.clear(); });
  },
  async add(store, value) {
    const d = await openDb();
    const t = d.transaction(store, 'readwrite');
    const req = t.objectStore(store).add(value);
    return reqToPromise(req);
  },

  // meta helpers
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
  const out = { exportedAt: new Date().toISOString(), app: 'mastering-urdu-shayari', version: 1, stores: {} };
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
