export type Location = 'Fridge' | 'Freezer' | 'Pantry';
export type Status = 'active' | 'used' | 'binned';

export interface Item {
  id: string;
  name: string;
  brand?: string;
  image?: string;        // URL (Open Food Facts) or data URL
  barcode?: string;
  categoryId: string;
  location: Location;
  quantity: number;
  unit?: string;
  expiry?: string;       // yyyy-mm-dd
  expiryMonthOnly?: boolean;
  opened?: string;       // yyyy-mm-dd
  addedAt: number;
  status: Status;
  finishedAt?: number;
}

export interface Category { id: string; name: string; icon: string; preset?: boolean; }
export interface ShopItem { id: string; name: string; done: boolean; addedAt: number; fromItemId?: string; }

export type Provider = 'gemini' | 'openai';
export interface Settings {
  provider: Provider;
  geminiKey: string;
  geminiModel: string;
  openaiKey: string;
  openaiModel: string;
  leadDays: number;
  lastNotified?: string;   // yyyy-mm-dd, avoid repeat notifications on the same day
}

export interface WasteEvent { id: string; name: string; categoryId: string; type: 'used' | 'binned'; at: number; }
