// Bill arithmetic shared by the cashier service and the till preview, so both show
// the same total. All amounts are integer minor units (paise for INR).
//
//   items - discounts + service charge = taxable value
//   taxable value per GST rate -> CGST + SGST (half the rate each)
//   taxable + tax -> rounded to the nearest whole currency unit (round-off line)

export type DiscountKind = 'percent' | 'amount';

export interface PricingLine {
  id: string;
  lineTotalMinor: number;
  taxRateBps: number;
  taxCode: string | null;
}

export interface PricingDiscount {
  /** Omitted for a whole-bill discount. */
  lineId?: string | null;
  kind: DiscountKind;
  /** Basis points for a percentage, minor units for an amount. */
  value: number;
}

export interface PricingInput {
  lines: PricingLine[];
  discounts: PricingDiscount[];
  serviceChargeBps: number;
  /** GST rate charged on the service charge (the outlet's restaurant rate). */
  serviceTaxRateBps: number;
  /** Round the payable total to this many minor units; 0 disables round-off. */
  roundToMinor: number;
}

export interface TaxLine {
  taxRateBps: number;
  taxCode: string | null;
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
}

export interface PricedBill {
  subtotalMinor: number;
  /** Applied amount for each input discount, in input order. */
  discountAmounts: number[];
  discountMinor: number;
  serviceChargeMinor: number;
  taxableMinor: number;
  taxLines: TaxLine[];
  taxTotalMinor: number;
  roundOffMinor: number;
  totalMinor: number;
}

function discountAmount(base: number, discount: PricingDiscount): number {
  if (base <= 0) return 0;
  const amount = discount.kind === 'percent' ? Math.round(base * discount.value / 10000) : discount.value;
  return Math.max(0, Math.min(base, amount));
}

/** Spreads an amount across weights so the parts add up exactly (largest remainder). */
function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!total || !amount) return weights.map(() => 0);
  const exact = weights.map(weight => amount * weight / total);
  const parts = exact.map(Math.floor);
  let remainder = amount - parts.reduce((sum, part) => sum + part, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction);
  for (const { index } of order) { if (remainder <= 0) break; parts[index]! += 1; remainder -= 1; }
  return parts;
}

export function priceBill(input: PricingInput): PricedBill {
  const net = input.lines.map(line => line.lineTotalMinor);
  const subtotalMinor = net.reduce((sum, value) => sum + value, 0);
  const discountAmounts = input.discounts.map(() => 0);
  // Item discounts first, then whole-bill discounts on what remains.
  input.discounts.forEach((discount, index) => {
    if (!discount.lineId) return;
    const position = input.lines.findIndex(line => line.id === discount.lineId);
    if (position < 0) return;
    const amount = discountAmount(net[position]!, discount);
    net[position]! -= amount; discountAmounts[index] = amount;
  });
  input.discounts.forEach((discount, index) => {
    if (discount.lineId) return;
    const amount = discountAmount(net.reduce((sum, value) => sum + value, 0), discount);
    allocate(amount, net).forEach((part, position) => { net[position]! -= part; });
    discountAmounts[index] = amount;
  });
  const itemsAfterDiscount = net.reduce((sum, value) => sum + value, 0);
  const serviceChargeMinor = Math.round(itemsAfterDiscount * input.serviceChargeBps / 10000);

  const buckets = new Map<string, TaxLine>();
  const add = (taxRateBps: number, taxCode: string | null, taxable: number) => {
    if (!taxable) return;
    const key = `${taxRateBps}:${taxCode ?? ''}`;
    const bucket = buckets.get(key) ?? { taxRateBps, taxCode, taxableMinor: 0, cgstMinor: 0, sgstMinor: 0 };
    bucket.taxableMinor += taxable; buckets.set(key, bucket);
  };
  input.lines.forEach((line, position) => add(line.taxRateBps, line.taxCode, net[position]!));
  add(input.serviceTaxRateBps, null, serviceChargeMinor);
  const taxLines = [...buckets.values()].sort((a, b) => a.taxRateBps - b.taxRateBps || (a.taxCode ?? '').localeCompare(b.taxCode ?? ''));
  for (const line of taxLines) {
    // Intra-state supply: half the GST rate each as central and state tax.
    line.cgstMinor = Math.round(line.taxableMinor * line.taxRateBps / 20000);
    line.sgstMinor = line.cgstMinor;
  }
  const taxTotalMinor = taxLines.reduce((sum, line) => sum + line.cgstMinor + line.sgstMinor, 0);
  const taxableMinor = itemsAfterDiscount + serviceChargeMinor;
  const raw = taxableMinor + taxTotalMinor;
  const totalMinor = input.roundToMinor > 0 ? Math.round(raw / input.roundToMinor) * input.roundToMinor : raw;
  return {
    subtotalMinor, discountAmounts, discountMinor: subtotalMinor - itemsAfterDiscount, serviceChargeMinor,
    taxableMinor, taxLines, taxTotalMinor, roundOffMinor: totalMinor - raw, totalMinor,
  };
}

/** Whole-unit round-off applies to rupee bills; other currencies keep exact totals. */
export function roundToMinorFor(currency: string): number { return currency === 'INR' ? 100 : 0; }
