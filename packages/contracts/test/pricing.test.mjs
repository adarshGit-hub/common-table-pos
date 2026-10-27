import assert from 'node:assert/strict';
import test from 'node:test';
import { priceBill } from '../dist/pricing.js';

const line = (id, lineTotalMinor, taxRateBps = 500, taxCode = null) => ({ id, lineTotalMinor, taxRateBps, taxCode });
const base = { discounts: [], serviceChargeBps: 0, serviceTaxRateBps: 500, roundToMinor: 100 };

test('splits GST into equal CGST and SGST and rounds the payable total to the rupee', () => {
  const bill = priceBill({ ...base, lines: [line('a', 7000), line('b', 2500)] });
  assert.equal(bill.subtotalMinor, 9500);
  assert.deepEqual(bill.taxLines, [{ taxRateBps: 500, taxCode: null, taxableMinor: 9500, cgstMinor: 238, sgstMinor: 238 }]);
  assert.equal(bill.taxTotalMinor, 476);
  assert.equal(bill.roundOffMinor, 24);
  assert.equal(bill.totalMinor, 10000);
});

test('applies item discounts, then whole-bill discounts, before service charge and tax', () => {
  const bill = priceBill({ ...base, serviceChargeBps: 1000, roundToMinor: 0,
    lines: [line('a', 10000), line('b', 5000, 1800, '996331')],
    discounts: [{ lineId: 'a', kind: 'amount', value: 2000 }, { kind: 'percent', value: 1000 }] });
  assert.deepEqual(bill.discountAmounts, [2000, 1300]);
  assert.equal(bill.discountMinor, 3300);
  assert.equal(bill.serviceChargeMinor, 1170);
  assert.equal(bill.taxableMinor, 11700 + 1170);
  // Bill discount spread 8000:5000 -> 800 and 500; service taxed at the outlet rate.
  assert.deepEqual(bill.taxLines.map(row => [row.taxRateBps, row.taxableMinor]), [[500, 7200 + 1170], [1800, 4500]]);
  assert.equal(bill.totalMinor, bill.taxableMinor + bill.taxTotalMinor);
});

test('discounts never exceed the amount they apply to', () => {
  const bill = priceBill({ ...base, lines: [line('a', 1000)], discounts: [{ lineId: 'a', kind: 'amount', value: 5000 }, { kind: 'amount', value: 100 }] });
  assert.deepEqual(bill.discountAmounts, [1000, 0]);
  assert.equal(bill.totalMinor, 0);
});

test('whole-bill discount allocation always adds up exactly', () => {
  const bill = priceBill({ ...base, roundToMinor: 0, lines: [line('a', 333), line('b', 333), line('c', 334)], discounts: [{ kind: 'amount', value: 100 }] });
  assert.equal(bill.taxableMinor, 900);
  assert.equal(bill.taxLines[0].taxableMinor, 900);
});
