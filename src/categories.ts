import type { Category } from './types';

export const PRESET_CATEGORIES: Category[] = [
  { id: 'dairy', name: 'Dairy', icon: '🥛' },
  { id: 'meat', name: 'Meat & Seafood', icon: '🥩' },
  { id: 'produce', name: 'Produce', icon: '🥦' },
  { id: 'bakery', name: 'Bakery', icon: '🍞' },
  { id: 'pantry', name: 'Pantry', icon: '🥫' },
  { id: 'frozen', name: 'Frozen', icon: '🧊' },
  { id: 'snacks', name: 'Snacks', icon: '🍪' },
  { id: 'drinks', name: 'Drinks', icon: '🧃' },
  { id: 'condiments', name: 'Condiments & Sauces', icon: '🍯' },
  { id: 'canned', name: 'Canned', icon: '🥫' },
  { id: 'spices', name: 'Spices', icon: '🌶️' },
  { id: 'household', name: 'Household', icon: '🧻' },
  { id: 'other', name: 'Other', icon: '📦' },
].map(c => ({ ...c, preset: true }));

export const ICON_CHOICES = ['🥛','🧀','🥚','🥩','🍗','🐟','🦐','🥦','🥕','🍎','🍌','🥑','🍅','🧅','🍞','🥐','🥫','🍝','🍚','🌾','🧊','🍦','🍕','🍪','🍫','🥜','🍿','🧃','☕','🍷','🍺','🍯','🧂','🌶️','🫙','🧻','🧼','🧴','🐶','🐱','👶','💊','🌿','🍳','🥗','📦'];

/** Offline keyword rules: used when there is no AI key, and as an instant first guess. */
const RULES: [string, RegExp][] = [
  ['dairy', /milk|cheese|yog(h)?urt|butter|cream|feta|parmesan|mozzarella|cheddar|custard|kefir|egg/i],
  ['meat', /chicken|beef|pork|lamb|mince|steak|sausage|bacon|ham|salami|fish|salmon|tuna steak|prawn|shrimp|turkey|seafood/i],
  ['frozen', /frozen|ice ?cream|peas froz|nugget|fish finger/i],
  ['produce', /apple|banana|orange|lettuce|tomato|potato|onion|carrot|broccoli|spinach|avocado|berr(y|ies)|grape|lemon|lime|cucumber|capsicum|mushroom|garlic|ginger|fruit|veg|herb|salad/i],
  ['bakery', /bread|loaf|roll|bun|croissant|muffin|bagel|wrap|tortilla|pita|cake|sourdough/i],
  ['canned', /\bcan(ned)?\b|tinned|baked beans|chickpea|tuna|coconut milk|diced tomato/i],
  ['condiments', /sauce|ketchup|mayo|mustard|vinegar|dressing|jam|honey|vegemite|peanut butter|syrup|relish|soy|chutney|pesto/i],
  ['spices', /spice|pepper|salt|cumin|paprika|cinnamon|oregano|turmeric|curry powder|chilli flakes|seasoning|stock cube/i],
  ['drinks', /juice|water|soda|cola|coke|tea|coffee|beer|wine|drink|kombucha|lemonade|cordial/i],
  ['snacks', /chip|crisp|biscuit|cookie|chocolate|lolly|lollies|candy|cracker|popcorn|nut bar|muesli bar|tim ?tam/i],
  ['household', /detergent|soap|shampoo|toilet|tissue|paper towel|foil|cling|bin bag|dishwash|laundry|toothpaste|sponge|bleach|cleaner/i],
  ['pantry', /pasta|rice|flour|sugar|oil|cereal|oats|noodle|lentil|bean|quinoa|couscous|stock|baking|cocoa/i],
];
export function guessCategory(name: string): string {
  for (const [id, re] of RULES) if (re.test(name)) return id;
  return 'other';
}
/** Rough default storage location for a category. */
export function defaultLocation(catId: string): 'Fridge' | 'Freezer' | 'Pantry' {
  if (catId === 'frozen') return 'Freezer';
  if (['dairy', 'meat', 'produce'].includes(catId)) return 'Fridge';
  return 'Pantry';
}
