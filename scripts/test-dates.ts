import { parseExpiry } from '../src/dates.ts';
const today = new Date(2026, 10, 15); // 15 Nov 2026
const cases: [string, string | null][] = [
  ['12/03/26', '2026-03-12'], ['12.03.2026', '2026-03-12'], ['12 MAR 2026', '2026-03-12'],
  ['BB 03/26', '2026-03-31'], ['Use by 12 Mar', '2027-03-12'], ['EXP 2026-03-12', '2026-03-12'],
  ['Best Before MAR 2027', '2027-03-31'], ['BBE 05/2027', '2027-05-31'], ['12MAR26', '2026-03-12'],
  ['Packed 01/11/26 Use By 20/11/26', '2026-11-20'], ['EXP 201126', '2026-11-20'], ['best before 3 dec', '2026-12-03'],
  ['L1234 BB 1O/O3/27', '2027-03-10'], ['Dec 5, 2026', '2026-12-05'], ['USE BY: 28-11-26', '2026-11-28'],
  ['05 12 2026', '2026-12-05'], ['BEST BEFORE END JUN 27', '2027-06-30'], ['12/03', '2027-03-12'], ['25/11', '2026-11-25'],
  ['USE BY 05 DEC 2026', '2026-12-05'], ['EXP 2027-01-15', '2027-01-15'], ['BEST BEFORE 08/27', '2027-08-31'], ['BB 3/4/27', '2027-04-03'],
  ['BBE: 15 JAN 27 L2311 14:32', '2027-01-15'], ['13:45 BB 20.11.26', '2026-11-20'], ['Best Before: 29/02/28', '2028-02-29'],
];
// Impossible dates must not produce a date
for (const bad of ['BB 31/02/27', 'EXP 29.02.27', 'NET 500G', '']) cases.push([bad, null as unknown as string]);
let fail = 0;
for (const [input, want] of cases) {
  const got = parseExpiry(input, today)?.iso ?? null;
  const ok = got === want; if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${input.padEnd(34)} → ${got}${ok ? '' : `  (want ${want})`}`);
}
console.log(fail ? `${fail} failed` : 'all passed'); process.exit(fail ? 1 : 0);
