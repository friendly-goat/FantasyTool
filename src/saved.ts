// The last data the server sent, kept in this browser (IndexedDB), so the app opens straight onto
// it, even while the server is waking up or the phone is offline, and swaps in newer data as it
// arrives. Only what the signed-in user has already been shown is kept, and only on this device;
// signing out clears it. Nothing here is required: without IndexedDB (some private modes) the app
// simply loads from the server as before.

const DATABASE = "fantasytool";
const STORE = "saved";
/** Bump to drop everything saved by an older version of the app (the shapes changed). */
const VERSION = 1;

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const request = indexedDB.open(DATABASE, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
        db.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const transaction = db.transaction(STORE, mode);
          const request = work(transaction.objectStore(STORE));
          transaction.oncomplete = () => resolve(request ? (request.result as T) : undefined);
          transaction.onerror = () => resolve(undefined);
          transaction.onabort = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

/** A saved value, or undefined. Never throws. */
export function readSaved<T>(key: string): Promise<T | undefined> {
  return run<T>("readonly", (store) => store.get(key));
}

/** Saves a value (replacing any before it). Never throws. */
export function writeSaved(key: string, value: unknown): Promise<void> {
  return run<void>("readwrite", (store) => {
    store.put(value, key);
  }).then(() => undefined);
}

/** Forgets everything saved (on signing out, or switching league). */
export function clearSaved(): Promise<void> {
  return run<void>("readwrite", (store) => {
    store.clear();
  }).then(() => undefined);
}

export const savedKeys = {
  config: "config",
  session: "session",
  league: (leagueId: string) => `league:${leagueId}`,
  stats: (leagueId: string) => `stats:${leagueId}`,
  schedule: (leagueId: string, week: number) => `schedule:${leagueId}:${week}`,
  history: (leagueId: string) => `history:${leagueId}`,
  draft: (leagueId: string) => `draft:${leagueId}`,
  plan: (leagueId: string, rosterId: number) => `plan:${leagueId}:${rosterId}`,
};
