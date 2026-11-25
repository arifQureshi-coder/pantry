import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  detectStore, expandAbbrev, joinReceiptTexts, parseMoneyOcr, parseReceiptText, parseReceiptParts,
  receiptPurchaseDate, receiptTotalCheck, shouldFallbackToAi, categorizeReceiptName,
} from '../src/receipt.ts';
import { PRESET_CATEGORIES } from '../src/categories.ts';

const fx = (name: string) => readFileSync(resolve('scripts/fixtures/receipts', name), 'utf8');

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


// --- real Woolworths Merrylands layout (clean transcription) ---
const wwM = parseReceiptText(fx('ww-merrylands.clean.txt'), cats, {}, today);
const wwMlist = wwM.lines.map(l => `${l.name} x${l.quantity} $${l.price}`).join(' | ');
check(wwM.store === 'woolworths', 'WW Merrylands store');
check(wwM.lines.length === 11, `WW Merrylands has 11 item lines, got ${wwM.lines.length}`, wwMlist);
const bund = wwM.lines.find(l => /Bundaberg Sarsaparilla/i.test(l.name));
check(!!bund && !/#/.test(bund!.name) && bund!.quantity === 2 && bund!.price === 11.5, 'WW # prefix stripped, Bundaberg 2 @ 5.75 = 11.50', `${bund?.name} x${bund?.quantity} $${bund?.price}`);
const bag = wwM.lines.find(l => /Paper Bag/i.test(l.name));
check(bag?.quantity === 2 && bag?.price === 0.5, 'WW paper bags 2 @ 0.25 = 0.50', `${bag?.quantity} ${bag?.price}`);
const pasta = wwM.lines.find(l => /San Remo/i.test(l.name));
check(pasta?.price === 2.95, 'WW San Remo penne 2.95', String(pasta?.price));
const garlic = wwM.lines.find(l => /Garlic Paste/i.test(l.name));
const italian = wwM.lines.find(l => /Herb Tube Italian/i.test(l.name));
const chilli = wwM.lines.find(l => /Chilli Mild/i.test(l.name));
check(garlic?.quantity === 2 && garlic?.price === 6, 'WW garlic 2 @ 4.00 shares ANY 2 for $6 (net 6.00)', `${garlic?.quantity} ${garlic?.price}`);
check(italian?.price === 3 && chilli?.price === 3, 'WW Italian + Chilli net $3 each after multibuy', `${italian?.price} ${chilli?.price}`);
const jelly = wwM.lines.find(l => /Jelly Beans/i.test(l.name));
check(jelly?.price === 5 && !/#/.test(jelly?.name ?? ''), 'WW Allens Jelly Beans is $5, not in the herb-tube deal', String(jelly?.price));
const turk = wwM.lines.find(l => /Turkey Mince/i.test(l.name));
check(turk?.quantity === 2 && turk?.price === 12, 'WW Ingham Turkey OFFER -$2 off 14.00 → 12.00', `${turk?.quantity} ${turk?.price}`);
const party = wwM.lines.find(l => /Party Mix/i.test(l.name));
check(party?.quantity === 2 && party?.price === 28, 'WW Allens Party Mix 2 @ 14.00 = 28.00', `${party?.quantity} ${party?.price}`);
const caramel = wwM.lines.find(l => /Caramel/i.test(l.name));
check(!!caramel && /Nut Salted/i.test(caramel!.name), 'WW CamelCase NutSalted → Nut Salted', caramel?.name);
check(wwM.total === 85.95 && wwM.sum === 85.95 && wwM.totalOk, `WW Merrylands total checks out (sum ${wwM.sum} total ${wwM.total})`);
check(wwM.date === '2025-05-18', 'WW Merrylands purchase date 18/05/2025', String(wwM.date));
check(!wwM.lines.some(l => /subtotal|total/i.test(l.name)), 'WW Merrylands skipped 16 SUBTOTAL / TOTAL');

// --- Tesseract OCR text from the same photo (noise allowed) ---
const wwOcr = parseReceiptText(fx('ww-merrylands.ocr.txt'), cats, {}, today);
const wwOcrList = wwOcr.lines.map(l => `${l.name} x${l.quantity} $${l.price}`).join(' | ');
check(wwOcr.store === 'woolworths', 'OCR WW still detected via "fresh food" header', wwOcr.store);
check(wwOcr.lines.some(l => /Pasta|Penne/i.test(l.name)), 'OCR finds the pasta line', wwOcrList);
check(wwOcr.lines.some(l => /Herb Tube/i.test(l.name)), 'OCR finds a Herb Tube line', wwOcrList);
check(wwOcr.lines.some(l => /Turkey/i.test(l.name)), 'OCR finds the turkey line', wwOcrList);
check(wwOcr.lines.some(l => /Kellogg/i.test(l.name)), 'OCR finds a Kellogg cereal line', wwOcrList);
const turkO = wwOcr.lines.find(l => /Turkey/i.test(l.name) && !/OFFER/i.test(l.name));
check(turkO?.price === 12, 'OCR applies Ingham Turkey OFFER -2.00 to the mince line', `${turkO?.price} // ${wwOcrList}`);
check(wwOcr.total === 85.95, 'OCR prefers SUBTOTAL $85.95 over a garbled TOTAL 5.45', String(wwOcr.total));

// --- Aldi layout: SKU, GST letter, Qty ea., abbreviations, surcharge, notes ---
const aldiReal = parseReceiptText(fx('aldi.clean.txt'), cats, {}, today);
const aldiList = aldiReal.lines.map(l => `${l.name} x${l.quantity} $${l.price}`).join(' | ');
check(aldiReal.store === 'aldi', 'Aldi store from header');
const coke = aldiReal.lines.find(l => /Coke Zero/i.test(l.name));
check(coke?.quantity === 4 && coke?.price === 11.96 && !/366905/.test(coke?.name ?? ''), 'Aldi SKU stripped, Coke 4 @ 2.99 ea. = 11.96', `${coke?.name} x${coke?.quantity} $${coke?.price}`);
const soy = aldiReal.lines.find(l => /Soy/i.test(l.name));
check(!!soy && /Milk UHT Organic Soy/i.test(soy!.name), 'Aldi MilkUHTOrgSoy expands', soy?.name);
const bread = aldiReal.lines.find(l => /Bread/i.test(l.name));
check(!!bread && /Vitamin White Bread/i.test(bread!.name), 'Aldi VitmnWhtBread expands', bread?.name);
const chs = aldiReal.lines.find(l => /Cheese|Chs/i.test(l.name));
check(!!chs && /Cheese Slice/i.test(chs!.name), 'Aldi Chs Slc expands', chs?.name);
check(!aldiReal.lines.some(l => /surcharge|card sales|84\.95|5x1|175g/i.test(l.name)), 'Aldi skips surcharge, card sales, and handwritten notes', aldiList);
check(aldiReal.total === 63.48 && aldiReal.sum === 63.48 && aldiReal.totalOk, `Aldi Total (INCL GST) $63.48 checks out (sum ${aldiReal.sum})`);

// --- Costco layout: code, uppercase name, 1x, price with & ---
const costco = parseReceiptText(fx('costco.clean.txt'), cats, {}, today);
const costcoList = costco.lines.map(l => `${l.name} x${l.quantity} $${l.price}`).join(' | ');
check(costco.store === 'costco', 'Costco store from header');
check(costco.lines.length === 3, `Costco has 3 items, got ${costco.lines.length}`, costcoList);
const olives = costco.lines.find(l => /Kalamata Olives/i.test(l.name));
check(olives?.quantity === 1 && olives?.price === 12.99, 'Costco 1x price with & marker', `${olives?.quantity} ${olives?.price}`);
const roti = costco.lines.find(l => /Rotisserie Chicken/i.test(l.name));
check(roti?.quantity === 1 && roti?.price === 8.99, 'Costco rotisserie chicken', `${roti?.quantity} ${roti?.price}`);
const bake = costco.lines.find(l => /Take/i.test(l.name));
check(!!bake && /Kirkland/i.test(bake!.name) && /Chicken/i.test(bake!.name) && bake!.quantity === 2 && bake!.price === 15.98,
  'Costco KS TAKE & BAKE CHK expands, 2x 15.98', `${bake?.name} x${bake?.quantity} $${bake?.price}`);
check(costco.total == null && costco.totalOk, 'Costco partial photo (no total) does not warn');
check(!costco.lines.some(l => /eftpos|approved/i.test(l.name)), 'Costco skipped EFTPOS footer');

// --- two receipts side by side: parse separately, do not mix columns ---
const two = parseReceiptParts([fx('ww-charlestown.clean.txt'), fx('coles-charlestown.clean.txt')], cats, {}, today);
check(/2 receipts/i.test(two.warning ?? '') && /Woolworths \$173/i.test(two.warning ?? '') && /Coles \$200/i.test(two.warning ?? ''),
  'two-receipt photo warns with both totals', two.warning);
check(two.total === 373, 'two-receipt combined printed total 173+200=373', String(two.total));
check(two.lines.some(l => /Chicken Breast/i.test(l.name)) && two.lines.some(l => /Butter/i.test(l.name) || /Coles Butter/i.test(l.name)),
  'two-receipt merge keeps items from both shops', two.lines.map(l => l.name).join(', '));
check(two.date === '2026-04-12', 'two-receipt date 12/04/2026', String(two.date));

console.log(fail ? `${fail} failed, ${pass} passed` : `${pass} passed`);
process.exit(fail ? 1 : 0);
