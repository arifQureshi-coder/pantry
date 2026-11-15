/** Open Food Facts lookup (free, no key). */
export interface Product { name: string; brand?: string; image?: string; categoriesText?: string; quantity?: string; }
export async function lookupBarcode(code: string): Promise<Product | null> {
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,product_name_en,brands,image_front_small_url,image_url,categories,quantity`);
    if (!r.ok) return null;
    const j = await r.json();
    if (j.status !== 1 || !j.product) return null;
    const p = j.product;
    const name = (p.product_name_en || p.product_name || '').trim();
    if (!name) return null;
    return { name, brand: p.brands?.split(',')[0]?.trim(), image: p.image_front_small_url || p.image_url, categoriesText: p.categories, quantity: p.quantity };
  } catch { return null; }
}
