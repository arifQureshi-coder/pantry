import type { Item, Category, Collection, ShopItem, Settings, WasteEvent, Purchase } from './types';
import { PRESET_CATEGORIES } from './categories';

/** Tiny promise wrapper around IndexedDB. Everything lives on this device only. */
const DB_NAME = 'pantry';
const STORES = ['items', 'categories', 'shopping', 'events', 'kv', 'expiryJobs', 'purchases', 'collections'] as const;
const DB_VERSION = 4;
export const REGULAR_ID = 'regular';
export const REGULAR: Collection = { id: REGULAR_ID, name: 'Regular', builtin: true, createdAt: 0 };
type StoreName = typeof STORES[number];
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = e => {
      const db = r.result;
      const tx = r.transaction!;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: s === 'kv' ? 'key' : 'id' });
      // v4: collections. Existing items, purchases and used/binned history join Regular. Nothing is deleted.
      if (e.oldVersion < 4) {
        tx.objectStore('collections').put(REGULAR);
        if (e.oldVersion > 0) {
          for (const name of ['items', 'purchases', 'events'] as const) {
            tx.objectStore(name).openCursor().onsuccess = ev => {
              const cur = (ev.target as IDBRequest<IDBCursorWithValue | null>).result;
              if (!cur) return;
              if (!cur.value.collectionId) cur.update({ ...cur.value, collectionId: REGULAR_ID });
              cur.continue();
            };
          }
          // Existing phones already have categories: never re-add presets the user deleted.
          tx.objectStore('kv').put({ key: 'catsSeeded', value: true });
        }
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function store(name: StoreName, mode: IDBTransactionMode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}
export async function getAll<T>(name: StoreName): Promise<T[]> { return req((await store(name)).getAll()) as Promise<T[]>; }
export async function get<T>(name: StoreName, id: string): Promise<T | undefined> { return req((await store(name)).get(id)) as Promise<T | undefined>; }
export async function put<T>(name: StoreName, v: T) { await req((await store(name, 'readwrite')).put(v)); }
export async function del(name: StoreName, id: string) { await req((await store(name, 'readwrite')).delete(id)); }
export async function clear(name: StoreName) { await req((await store(name, 'readwrite')).clear()); }

export interface ExpiryJob { id: string; itemId: string; photo: Blob; addedAt: number; attempts: number; }

export const DEFAULT_SETTINGS: Settings = {
  provider: 'gemini', geminiKey: '', geminiModel: 'gemini-3.6-flash',
  openaiKey: '', openaiModel: 'gpt-4o-mini', leadDays: 3, view: 'grouped',
};
export async function getSettings(): Promise<Settings> {
  const row = await req((await store('kv')).get('settings')) as { key: string; value: Settings } | undefined;
  return { ...DEFAULT_SETTINGS, ...(row?.value ?? {}) };
}
export async function saveSettings(s: Settings) { await put('kv', { key: 'settings', value: s }); }

export async function ensureCategories(): Promise<Category[]> {
  const cats = await getAll<Category>('categories');
  const seeded = await get<{ key: string; value: boolean }>('kv', 'catsSeeded');
  if (cats.length || seeded?.value) {
    if (!seeded?.value) await put('kv', { key: 'catsSeeded', value: true });
    return cats;
  }
  for (const c of PRESET_CATEGORIES) await put('categories', c);
  await put('kv', { key: 'catsSeeded', value: true });
  return [...PRESET_CATEGORIES];
}
export async function ensureCollections(): Promise<Collection[]> {
  const cols = await getAll<Collection>('collections');
  if (!cols.some(c => c.id === REGULAR_ID)) { await put('collections', REGULAR); cols.push(REGULAR); }
  return cols;
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

export interface Backup { app: 'pantry'; version: 1 | 2 | 3; exportedAt: string; items: Item[]; categories: Category[]; collections?: Collection[]; shopping: ShopItem[]; events: WasteEvent[]; purchases?: Purchase[]; settings: Omit<Settings, 'geminiKey' | 'openaiKey'>; }
export async function exportData(): Promise<Backup> {
  const { geminiKey, openaiKey, ...settings } = await getSettings();
  void geminiKey; void openaiKey;
  return { app: 'pantry', version: 3, exportedAt: new Date().toISOString(), items: await getAll('items'), categories: await getAll('categories'), collections: await getAll('collections'), shopping: await getAll('shopping'), events: await getAll('events'), purchases: await getAll('purchases'), settings };
}
export async function importData(b: Backup) {
  if (b?.app !== 'pantry' || !Array.isArray(b.items)) throw new Error('Not a Pantry backup file');
  for (const s of ['items', 'categories', 'collections', 'shopping', 'events', 'purchases'] as const) {
    await clear(s);
    for (const row of (b as any)[s] ?? []) await put(s, withCollection(s, row));
  }
  await put('kv', { key: 'catsSeeded', value: true });
  await ensureCollections();
  if (b.settings) await saveSettings({ ...(await getSettings()), ...b.settings });
}

/** Older backups have no collections: their rows join Regular. */
export function withCollection(store: string, row: any) {
  if ((store === 'items' || store === 'purchases' || store === 'events') && row && !row.collectionId) return { ...row, collectionId: REGULAR_ID };
  return row;
}
