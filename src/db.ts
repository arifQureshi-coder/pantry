import type { Item, Category, ShopItem, Settings, WasteEvent, Purchase } from './types';
import { PRESET_CATEGORIES } from './categories';

/** Tiny promise wrapper around IndexedDB. Everything lives on this device only. */
const DB_NAME = 'pantry';
const STORES = ['items', 'categories', 'shopping', 'events', 'kv', 'expiryJobs', 'purchases'] as const;
type StoreName = typeof STORES[number];
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 3);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: s === 'kv' ? 'key' : 'id' });
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
  openaiKey: '', openaiModel: 'gpt-4o-mini', leadDays: 3,
};
export async function getSettings(): Promise<Settings> {
  const row = await req((await store('kv')).get('settings')) as { key: string; value: Settings } | undefined;
  return { ...DEFAULT_SETTINGS, ...(row?.value ?? {}) };
}
export async function saveSettings(s: Settings) { await put('kv', { key: 'settings', value: s }); }

export async function ensureCategories(): Promise<Category[]> {
  const cats = await getAll<Category>('categories');
  if (cats.length) return cats;
  for (const c of PRESET_CATEGORIES) await put('categories', c);
  return PRESET_CATEGORIES;
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

export interface Backup { app: 'pantry'; version: 1 | 2; exportedAt: string; items: Item[]; categories: Category[]; shopping: ShopItem[]; events: WasteEvent[]; purchases?: Purchase[]; settings: Omit<Settings, 'geminiKey' | 'openaiKey'>; }
export async function exportData(): Promise<Backup> {
  const { geminiKey, openaiKey, ...settings } = await getSettings();
  void geminiKey; void openaiKey;
  return { app: 'pantry', version: 2, exportedAt: new Date().toISOString(), items: await getAll('items'), categories: await getAll('categories'), shopping: await getAll('shopping'), events: await getAll('events'), purchases: await getAll('purchases'), settings };
}
export async function importData(b: Backup) {
  if (b?.app !== 'pantry' || !Array.isArray(b.items)) throw new Error('Not a Pantry backup file');
  for (const s of ['items', 'categories', 'shopping', 'events', 'purchases'] as const) {
    await clear(s);
    for (const row of (b as any)[s] ?? []) await put(s, row);
  }
  if (b.settings) await saveSettings({ ...(await getSettings()), ...b.settings });
}
