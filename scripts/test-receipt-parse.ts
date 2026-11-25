import {
  detectStore, expandAbbrev, joinReceiptTexts, parseMoneyOcr, parseReceiptText,
  receiptPurchaseDate, receiptTotalCheck, shouldFallbackToAi, categorizeReceiptName,
} from '../src/receipt.ts';
import { PRESET_CATEGORIES } from '../src/categories.ts';

const today = new Date(2026, 10, 16); // 16 Nov 2026
const cats = PRESET_CATEGORIES;
let fail = 0, pass = 0;
function check(ok: boolean, msg: string, detail = '') {
  if (ok) { pass++; console.log('PASS', msg); }
  else { fail++; console.error('FAIL', msg + (detail ? ` (${detail})` : '')); }
}

const WW = `WOOLWORTHS TOWN HALL
THE FRESH FOOD PEOPLE
TAX INVOICE ABN 88 000 014 675
Phone 13 00 00

MILK FULL CRM 2L                 3.20
BANANAS CAVENDISH                3.50
  0.512 kg NET @ $6.84/kg
WW FC MLK 2L                     3.20
WHITE BREAD 700G                 2.50
  2 @ $1.25
CHKN BREAST 500G                 9.00
  PRICE REDUCED                  1.50
BABY SPINACH 120G                3.00

SUBTOTAL                        23.90
PROMOTION SAVINGS                1.50
TOTAL                           22.90
GST INCLUDED                     1.85
VISA                            22.40
CHANGE                           0.00
EVERYDAY REWARDS
14/11/26 15:32
THANK YOU FOR SHOPPING`;

const COLES = `COLES SUPERMARKETS
TAX INVOICE
COLES MLK 2L                    $3.20
CC BTR 250G                     $5.50
BAGUETTE                        $3.00
  QTY 2 @ $1.50
TMTOS 400G                      $1.20
FLYBUYS POINTS EARNED 12
SUBTOTAL                       $13.00
TOTAL                          $13.00
GST                             $1.18
MASTERCARD                     $13.00
DATE 16/11/2026  09:41`;

const ALDI = `ALDI
TAX INVOICE
FULL CREAM MILK 2L           2.19 A
EGGS 12PK FREE RANGE         5.49 A
SPAGHETTI 500G               0.95 A
  2 @ 0.95
MINCE BEEF 500G              7.00 A
TOTAL                       16.58
EFTPOS                      16.58
10.11.26 18:05
THANK YOU`;

const GENERIC = `HARRIS FARM MARKETS
Invoice
Sourdough loaf                    6.00
Avocado each                      2.50
  3 @ $2.50
Honey 500g                        7.80
TOTAL                            21.30
16 Nov 2026`;

// --- money OCR ---
check(parseMoneyOcr('3.20') === 3.2, 'parseMoney 3.20');
check(parseMoneyOcr('$3.2O') === 3.2, 'parseMoney O→0');
check(parseMoneyOcr('3,20') === 3.2, 'parseMoney decimal comma');
check(parseMoneyOcr('1,250.00') === 1250, 'parseMoney thousands comma');
check(parseMoneyOcr('3.2S') === 3.25, 'parseMoney S→5');

// --- abbrev ---
check(expandAbbrev('WW FC MLK 2L') === 'Woolworths Full Cream Milk 2L', 'expand WW FC MLK 2L', expandAbbrev('WW FC MLK 2L'));
check(expandAbbrev('CC BTR 250G') === 'Coles Butter 250G', 'expand CC BTR');
check(expandAbbrev('CHKN BREAST') === 'Chicken BREAST', 'expand CHKN');
check(expandAbbrev('EGGS 12PK') === 'EGGS 12 Pack', 'expand 12PK', expandAbbrev('EGGS 12PK'));
check(expandAbbrev('Full Cream Milk') === 'Full Cream Milk', 'do not touch ordinary words');

// --- store detection ---
check(detectStore(WW) === 'woolworths', 'detect Woolworths');
check(detectStore(COLES) === 'coles', 'detect Coles');
check(detectStore(ALDI) === 'aldi', 'detect Aldi');
check(detectStore(GENERIC) === 'generic', 'detect generic');

// --- join overlapping parts ---
const part1 = `WOOLWORTHS
MILK 2L              3.20
BANANAS              3.50
SPINACH              3.00`;
const part2 = `BANANAS              3.50
SPINACH              3.00
BREAD                2.50
TOTAL                12.20`;
const joined = joinReceiptTexts([part1, part2]);
check((joined.match(/BANANAS/g) || []).length === 1 && (joined.match(/SPINACH/g) || []).length === 1 && /BREAD/.test(joined) && /MILK/.test(joined),
  'join overlapping parts drops the repeated boundary', joined);

// --- Woolworths fixture ---
const ww = parseReceiptText(WW, cats, {}, today);
check(ww.store === 'woolworths' && ww.lines.length === 6, `WW has 6 items, got ${ww.lines.length}`, ww.lines.map(l => `${l.name} x${l.quantity} $${l.price}`).join(' | '));
const wwMilk = ww.lines.find(l => /Full Cream Milk 2L/i.test(l.name) || /MILK FULL CRM/i.test(l.name));
const wwWwMilk = ww.lines.find(l => /Woolworths Full Cream Milk/i.test(l.name));
check(!!wwWwMilk, 'WW expands WW FC MLK 2L', ww.lines.map(l => l.name).join(', '));
const wwBan = ww.lines.find(l => /Banana/i.test(l.name));
check(wwBan?.quantity === 1 && wwBan?.price === 3.5, 'WW weighed bananas: qty 1, line total 3.50 (printed)', `${wwBan?.quantity} ${wwBan?.price}`);
// 0.512 * 6.84 = 3.502 → 3.50, and printed name-line price is 3.50 so keep it
const wwBread = ww.lines.find(l => /Bread/i.test(l.name));
check(wwBread?.quantity === 2 && wwBread?.price === 2.5, 'WW qty 2 @ 1.25 keeps printed line total 2.50', `${wwBread?.quantity} ${wwBread?.price}`);
const wwChkn = ww.lines.find(l => /Chicken/i.test(l.name));
check(wwChkn?.price === 7.5, 'WW per-item PRICE REDUCED 1.50 comes off the chicken (9.00-1.50)', String(wwChkn?.price));
check(!ww.lines.some(l => /subtotal|visa|gst|rewards|savings/i.test(l.name)), 'WW skipped totals, GST, payment, rewards, savings summary');
check(ww.date === '2026-11-14', 'WW purchase date 14/11/26', String(ww.date));
check(ww.total === 22.9 && ww.sum === 22.9 && ww.totalOk, `WW total checks out (sum ${ww.sum} total ${ww.total})`);
check(wwWwMilk?.categoryId === 'dairy' && wwChkn?.categoryId === 'meat' && wwBan?.categoryId === 'produce', 'WW keyword categories', `${wwWwMilk?.categoryId} ${wwChkn?.categoryId} ${wwBan?.categoryId}`);

// --- Coles ---
const coles = parseReceiptText(COLES, cats, {}, today);
check(coles.store === 'coles' && coles.lines.length === 4, `Coles has 4 items, got ${coles.lines.length}`, coles.lines.map(l => `${l.name} x${l.quantity} $${l.price}`).join(' | '));
const cBtr = coles.lines.find(l => /Butter/i.test(l.name));
check(!!cBtr && /Coles Butter/i.test(cBtr.name), 'Coles expands CC BTR', cBtr?.name);
const cBag = coles.lines.find(l => /Baguette/i.test(l.name));
check(cBag?.quantity === 2 && cBag?.price === 3, 'Coles QTY 2 @ 1.50 keeps line total $3.00', `${cBag?.quantity} ${cBag?.price}`);
check(coles.date === '2026-11-16', 'Coles date 16/11/2026', String(coles.date));
check(coles.totalOk && coles.total === 13, 'Coles total checks out');
check(!coles.lines.some(l => /flybuys|mastercard|gst/i.test(l.name)), 'Coles skipped flybuys, card, GST');

// --- Aldi ---
const aldi = parseReceiptText(ALDI, cats, {}, today);
check(aldi.store === 'aldi' && aldi.lines.length === 4, `Aldi has 4 items, got ${aldi.lines.length}`, aldi.lines.map(l => `${l.name} x${l.quantity} $${l.price}`).join(' | '));
const aSpag = aldi.lines.find(l => /Spaghetti/i.test(l.name));
check(aSpag?.quantity === 2 && aSpag?.price === 1.9, 'Aldi 2 @ 0.95, name line was one unit so line becomes 1.90', `${aSpag?.quantity} ${aSpag?.price}`);
check(aldi.date === '2026-11-10', 'Aldi date 10.11.26', String(aldi.date));
check(aldi.total === 16.58 && aldi.sum === 16.58 && aldi.totalOk, `Aldi total checks out (sum ${aldi.sum})`);
check(aldi.lines.find(l => /Milk/i.test(l.name))?.categoryId === 'dairy', 'Aldi milk → dairy');

// --- Generic ---
const gen = parseReceiptText(GENERIC, cats, {}, today);
check(gen.store === 'generic' && gen.lines.length === 3, `generic has 3 items, got ${gen.lines.length}`, gen.lines.map(l => `${l.name} x${l.quantity} $${l.price}`).join(' | '));
const gAvo = gen.lines.find(l => /Avocado/i.test(l.name));
check(gAvo?.quantity === 3 && gAvo?.price === 7.5, 'generic 3 @ 2.50: name had unit price, becomes 7.50', `${gAvo?.quantity} ${gAvo?.price}`);
check(gen.date === '2026-11-16', 'generic date 16 Nov 2026', String(gen.date));
check(gen.totalOk && gen.total === 21.3, 'generic total checks out');
check(gen.lines.find(l => /Sourdough/i.test(l.name))?.categoryId === 'bakery', 'generic sourdough → bakery');

// --- total check ---
const bad = receiptTotalCheck(20, 25);
check(!bad.ok && !!bad.warning && /25/.test(bad.warning!), 'total warning when off by more than $1', bad.warning);
check(receiptTotalCheck(20, 20.3).ok, 'total OK within $1');
check(receiptTotalCheck(100, 101.5).ok, 'total OK within 2%');
check(!receiptTotalCheck(100, 103).ok, 'total fails at 3%');

// --- date helper ---
check(receiptPurchaseDate('TOTAL 12.00\n14/11/26 15:32\nTHANK YOU', today) === '2026-11-14', 'purchase date from footer');
check(receiptPurchaseDate('NO DATE HERE\nTOTAL 12.00', today) === null, 'no date → null');

// --- learned categories ---
check(categorizeReceiptName('Mystery Snack', { 'mystery snack': 'snacks' }, cats) === 'snacks', 'learned mapping wins');
check(categorizeReceiptName('Mystery Snack', {}, cats) === 'other', 'unknown stays other');
check(categorizeReceiptName('Full Cream Milk', {}, cats) === 'dairy', 'keyword still works');

// --- AI fallback decision ---
const thin = { lines: [{ name: 'Milk', quantity: 1, categoryId: 'dairy', price: 3.2 }] as any, totalOk: true };
const none = { lines: [], totalOk: true };
const ok = { lines: ww.lines, totalOk: true };
const off = { lines: ww.lines, totalOk: false };
check(!shouldFallbackToAi(ok, true, true), 'no fallback when OCR is healthy and total matches');
check(!shouldFallbackToAi(off, false, true), 'toggle off: never fall back, even if total is wrong');
check(!shouldFallbackToAi(none, true, false), 'no key: never fall back');
check(shouldFallbackToAi(thin, true, true), 'fallback when OCR finds fewer than 2 items and toggle is on');
check(shouldFallbackToAi(none, true, true), 'fallback when OCR finds no items and toggle is on');
check(shouldFallbackToAi(off, true, true), 'fallback when total check fails and toggle is on');

console.log(fail ? `${fail} failed, ${pass} passed` : `${pass} passed`);
process.exit(fail ? 1 : 0);
