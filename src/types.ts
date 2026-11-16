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
  expiryStatus?: 'reading' | 'pending' | 'failed'; // undefined = confirmed (or no date)
  expiryRaw?: string;    // text the scanner read, until the date is confirmed
  noExpiry?: boolean;    // explicitly does not expire (not the same as a missing date)
  opened?: string;       // yyyy-mm-dd
  price?: number;        // unit price in AUD
  boughtOn?: string;     // yyyy-mm-dd, optional purchase date
  collectionId?: string; // grocery run / "spree"; missing = Regular
  addedAt: number;
  status: Status;
  finishedAt?: number;
}

export interface Category { id: string; name: string; icon: string; preset?: boolean; }
/** A grocery run ("spree"), e.g. Regular, Stocking up, Guests – Dec. Every item belongs to one. */
export interface Collection { id: string; name: string; builtin?: boolean; createdAt: number; }
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
  view?: 'grouped' | 'list' | 'grid';
}

export interface WasteEvent { id: string; itemId?: string; name: string; categoryId: string; collectionId?: string; type: 'used' | 'binned'; at: number; unitPrice?: number; quantity?: number; }

/** A recorded spend, kept even if the item is later used up or deleted. */
export interface Purchase {
  id: string;
  itemId?: string;
  name: string;
  barcode?: string;
  categoryId: string;
  collectionId?: string;
  unitPrice: number;
  quantity: number;
  total: number;
  at: number;
}
