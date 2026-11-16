import { receiptDate } from '../src/ai.ts';
const today = new Date(2026, 10, 16); // 16 Nov 2026
const cases: [unknown, string | null][] = [
  ['2026-11-14', '2026-11-14'], ['2026-11-16', '2026-11-16'], ['2026-11-17', null], // future
  ['2026-02-30', null], ['14/11/2026', null], [null, null], [undefined, null], ['', null], ['1999-01-01', null], ['2025-12-31', '2025-12-31'],
];
let fail = 0;
for (const [input, want] of cases) {
  const got = receiptDate(input, today);
  const ok = got === want; if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(input).padEnd(12)} → ${got}${ok ? '' : `  (want ${want})`}`);
}
console.log(fail ? `${fail} failed` : 'all passed'); process.exit(fail ? 1 : 0);
