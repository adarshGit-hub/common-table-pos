import type { DiscountKind, TaxLine } from './pricing.js';
export * from './pricing.js';
export type OrderType = 'dine_in' | 'takeaway';
export type OrderStatus = 'sent' | 'preparing' | 'ready' | 'paid' | 'cancelled';
export type PaymentMethod = 'cash' | 'upi' | 'card';

export interface ModifierOption {
  id: string;
  group: string;
  name: string;
  priceDeltaMinor: number;
}

export interface MenuItem {
  id: string;
  name: string;
  category: string;
  priceMinor: number;
  emoji: string;
  color: string;
  tag?: string;
  vegetarian: boolean;
  available: boolean;
  kitchenStation: string;
  modifiers: ModifierOption[];
  /** Null or omitted means use the outlet's configured demonstration fallback. */
  taxCode?: string | null;
  /** Null or omitted means use the outlet's configured demonstration fallback; zero is an explicit 0% rate. */
  taxRateBps?: number | null;
}

export interface DiningTableConfig {
  id: string;
  name: string;
  capacity: number;
  sortOrder: number;
}

export interface DiningAreaConfig {
  id: string;
  name: string;
  sortOrder: number;
  tables: DiningTableConfig[];
}

export interface KitchenStationConfig {
  id: string;
  name: string;
  sortOrder: number;
}

export interface OutletLayoutConfig {
  areas: DiningAreaConfig[];
  stations: KitchenStationConfig[];
}

export interface OrderLineDraft {
  menuItemId: string;
  quantity: number;
  note?: string;
  modifierIds?: string[];
}

export interface CreateOrderCommand {
  commandId: string;
  tenantId: string;
  outletId: string;
  terminalId: string;
  orderType: OrderType;
  /** Preferred for dine-in. A legacy client may send only tableLabel. */
  tableId?: string;
  tableLabel?: string;
  guestCount?: number;
  note?: string;
  /** Optional guest details; a known phone number links the order to that customer. */
  customer?: CustomerInput;
  lines: OrderLineDraft[];
}

export interface CustomerInput {
  phone: string;
  name?: string;
}

export interface CustomerRecord {
  id: string;
  phone: string;
  name: string | null;
}

export interface CustomerSummary extends CustomerRecord {
  visitCount: number;
  lastVisitAt: string | null;
  totalSpendMinor: number;
}

export interface OrderLine {
  id: string;
  menuItemId: string;
  name: string;
  category: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  note?: string;
  kitchenStation: string;
  modifiers: ModifierOption[];
  taxCode?: string | null;
  taxRateBps?: number;
  voidedAt?: string;
  voidReason?: string;
}

export interface AddOrderLinesCommand {
  commandId: string;
  lines: OrderLineDraft[];
}

export interface VoidOrderLineCommand {
  commandId: string;
  reason: string;
}

export interface KitchenOrder {
  id: string;
  ticketId?: string;
  kitchenStation?: string;
  ticketStatus?: 'new' | 'preparing' | 'ready' | 'voided';
  orderNumber: string;
  orderType: OrderType;
  tableLabel: string | null;
  status: OrderStatus;
  note: string | null;
  createdAt: string;
  lines: OrderLine[];
  tokenNumber?: number | null;
}

export interface OrderRecord extends KitchenOrder {
  commandId: string;
  tenantId: string;
  outletId: string;
  terminalId: string;
  guestCount: number;
  currency: string;
  invoiceNumber?: string;
  taxRateBps: number;
  subtotalMinor: number;
  taxTotalMinor: number;
  totalMinor: number;
  paymentMethod?: PaymentMethod;
  tableId?: string | null;
  billPrintedAt?: string | null;
  /** 1: original per-line tax; 2: discounts, service charge, CGST/SGST and round-off. */
  pricingVersion?: number;
  discountMinor?: number;
  serviceChargeBps?: number;
  serviceChargeMinor?: number;
  roundOffMinor?: number;
  discounts?: OrderDiscount[];
  taxLines?: TaxLine[];
  customer?: CustomerRecord | null;
}

export interface OrderDiscount {
  id: string;
  lineId: string | null;
  kind: DiscountKind;
  value: number;
  appliedMinor: number;
  reason: string;
  createdAt: string;
}

export interface PaymentCommand {
  commandId: string;
  orderId: string;
  shiftId: string;
  method?: PaymentMethod;
  amountMinor?: number;
  tenders?: PaymentTender[];
}

/** One tender of a payment. A label (e.g. "Guest 2") prints a share slip; lineIds narrow it to those items. */
export interface PaymentTender {
  method: PaymentMethod;
  amountMinor: number;
  label?: string;
  lineIds?: string[];
}

export interface ShiftRecord {
  id: string;
  shiftNumber: string;
  status: 'open' | 'closed';
  openedAt: string;
  openingFloatMinor: number;
  closedAt?: string;
  countedCashMinor?: number;
  expectedCashMinor?: number;
  varianceMinor?: number;
}

export interface ShiftSummary {
  shift: ShiftRecord;
  salesByMethod: Record<PaymentMethod, number>;
  cashInMinor: number;
  cashOutMinor: number;
  expectedCashMinor: number;
}

export interface DailySalesReport {
  date: string;
  timeZone: string;
  outletName: string;
  currency: string;
  startAt: string;
  endAt: string;
  generatedAt: string;
  /** subtotalMinor is the taxable value (after discounts, including service charge), net of refunds. */
  totals: { paidOrderCount: number; subtotalMinor: number; taxTotalMinor: number; salesMinor: number;
    discountMinor: number; serviceChargeMinor: number; roundOffMinor: number };
  taxBreakdown: Array<{ taxCode: string | null; taxRateBps: number; taxMinor: number; cgstMinor: number; sgstMinor: number }>;
  refunds: { count: number; amountMinor: number };
  tenders: Array<{ method: PaymentMethod; amountMinor: number; paymentCount: number }>;
  items: Array<{ menuItemId: string; name: string; quantity: number; salesMinor: number }>;
  voids: { lineCount: number; quantity: number; amountMinor: number };
  shifts: { closedCount: number; expectedCashMinor: number; countedCashMinor: number; varianceMinor: number };
}

export interface CashMovementCommand {
  commandId: string;
  type: 'cash_in' | 'cash_out';
  amountMinor: number;
  reason: string;
}

export interface ServerMessage {
  type: 'kitchen.snapshot' | 'order.created' | 'order.updated' | 'floor.updated' | 'server.ready';
  payload: KitchenOrder[] | KitchenOrder | { outletId: string };
}

function demoItem(id:string,name:string,category:string,rupees:number,emoji:string,color:string,kitchenStation='Sweets',tag?:string,modifiers:ModifierOption[]=[]):MenuItem{
  return {id,name,category,priceMinor:rupees*100,emoji,color,...(tag?{tag}:{}),vegetarian:true,available:true,kitchenStation,modifiers};
}

const spiceChoices=(id:string):ModifierOption[]=>[
  {id:`${id}-mild`,group:'Spice',name:'Mild',priceDeltaMinor:0},
  {id:`${id}-medium`,group:'Spice',name:'Medium',priceDeltaMinor:0},
  {id:`${id}-spicy`,group:'Spice',name:'Spicy',priceDeltaMinor:0},
];

// Fictional POS training catalogue inspired by common Indore mithai-house menus.
// Prices are demonstrative estimates; this is not Apna Sweets' live menu.
export const DEMO_MENU: MenuItem[] = [
  demoItem('indori-poha','Indori Poha','Breakfast',70,'🍋','#f5ecd5','Hot kitchen','POPULAR'),
  demoItem('poha-jalebi-combo','Poha with Kesariya Jalebi','Breakfast',99,'🍋','#f5ecd5','Hot kitchen','COMBO'),
  demoItem('dal-kachori','Dal Kachori','Breakfast',45,'🥟','#f0e3cf','Hot kitchen'),
  demoItem('aloo-pyaz-kachori','Aloo Pyaz Kachori','Breakfast',35,'🥟','#f0e3cf','Hot kitchen'),
  demoItem('samosa','Samosa','Breakfast',25,'🔺','#f3e3cd'),
  demoItem('kesariya-jalebi','Kesariya Jalebi · 100 g','Breakfast',55,'🍯','#f6e7c7','Sweets','POPULAR'),
  demoItem('sabudana-khichdi','Sabudana Khichdi','Breakfast',110,'🥣','#f1eadb','Hot kitchen'),
  demoItem('sabudana-bada-dahi','Sabudana Bada with Dahi','Breakfast',65,'🥣','#f1eadb','Hot kitchen'),
  demoItem('sada-khaman','Sada Khaman · 100 g','Breakfast',38,'🟨','#f4edcf','Sweets'),
  demoItem('dahi-kachori','Dahi Kachori','Chaat & Snacks',55,'🥣','#f0e5d8','Chaat counter'),
  demoItem('fruit-chaat','Fresh Fruit Chaat','Chaat & Snacks',95,'🍎','#f1e7db','Chaat counter'),
  demoItem('pani-puri','Pani Puri · 6 pcs','Chaat & Snacks',70,'🟠','#f2e1cf','Chaat counter'),
  demoItem('sev-puri','Indori Sev Puri','Chaat & Snacks',85,'🍽️','#f4e8d6','Chaat counter'),
  demoItem('pav-bhaji','Pav Bhaji · 2 pav','Chaat & Snacks',143,'🍛','#f3e5d1','Hot kitchen','POPULAR',spiceChoices('pav-bhaji')),
  demoItem('chole-bhature','Chole Bhature · 2 bhature','North Indian',238,'🍛','#f0e3d0','Hot kitchen','POPULAR',spiceChoices('chole-bhature')),
  demoItem('paneer-tikka','Paneer Tikka · 8 pcs','North Indian',286,'🧀','#f1e2d2','Tandoor','POPULAR',spiceChoices('paneer-tikka')),
  demoItem('paneer-65','Paneer 65','North Indian',220,'🧀','#f3e3d3','Hot kitchen','POPULAR',spiceChoices('paneer-65')),
  demoItem('dal-makhani','Dal Makhani','North Indian',250,'🥘','#eee3d4','Hot kitchen'),
  demoItem('butter-paneer-masala','Butter Paneer Masala','North Indian',210,'🥘','#f0e1d3','Hot kitchen',undefined,spiceChoices('butter-paneer')),
  demoItem('veg-thali','Veg Thali','Thalis',219,'🍱','#eee5d8','Hot kitchen','POPULAR'),
  demoItem('special-thali','Special Bhojan Thali','Thalis',279,'🍱','#eee5d8','Hot kitchen','COMBO'),
  demoItem('dal-rice-bowl','Dal Rice Bowl','Thalis',149,'🍚','#f3eadc','Hot kitchen'),
  demoItem('gulab-jamun','Gulab Jamun · 2 pcs','Mawa & Milk Sweets',66,'🍮','#f0dfd3','Sweets','POPULAR'),
  demoItem('rasgulla','Rasgulla · 2 pcs','Bengali Sweets',36,'⚪','#f2eee5','Sweets','POPULAR'),
  demoItem('rasmalai','Rasmalai · 2 pcs','Bengali Sweets',90,'🥛','#f2ece1','Sweets'),
  demoItem('milk-cake','Milk Cake · 250 g','Mawa & Milk Sweets',150,'🍰','#f0e4d8','Sweets'),
  demoItem('kala-jamun','Kala Jamun · 2 pcs','Mawa & Milk Sweets',70,'🍮','#eadbd2','Sweets'),
  demoItem('sohan-halwa','Sohan Halwa · 250 g','Desi Ghee Sweets',155,'🟫','#eee0d0','Sweets'),
  demoItem('besan-laddu','Besan Laddu · 250 g','Desi Ghee Sweets',170,'🟡','#f1e7ce','Sweets'),
  demoItem('kaju-katli','Kaju Katli · 250 g','Dry Fruit Sweets',250,'💎','#eee6d4','Sweets','POPULAR'),
  demoItem('dry-fruit-laddu','Rose Dry Fruit Laddu · 250 g','Dry Fruit Sweets',310,'🟤','#ecdfd3','Sweets'),
  demoItem('kaju-kachori-sweet','Kaju Kachori · 250 g','Dry Fruit Sweets',317,'🥮','#eee1d1','Sweets'),
  demoItem('mixed-sweet-box','Assorted Mithai Box · 500 g','Gift Boxes',420,'🎁','#f2e4d5','Sweets','GIFT'),
  demoItem('namkeen-mixture','Indori Namkeen Mixture · 250 g','Namkeen & Dry Snacks',95,'🥜','#f2e3ce','Sweets'),
  demoItem('ratlami-sev','Ratlami Sev · 250 g','Namkeen & Dry Snacks',110,'🥨','#f3e5d3','Sweets','POPULAR'),
  demoItem('masala-peanuts','Masala Peanuts · 200 g','Namkeen & Dry Snacks',85,'🥜','#ecdfd1','Sweets'),
  demoItem('atta-nankhatai','Atta Nankhatai · 250 g','Cookies & Bakery',98,'🍪','#f0e2cd','Bakery'),
  demoItem('oats-cookies','Oats Cookies · 250 g','Cookies & Bakery',102,'🍪','#f0e2cd','Bakery'),
  demoItem('kesar-pista-cookies','Kesar Pista Cookies · 250 g','Cookies & Bakery',100,'🍪','#f0e2cd','Bakery'),
  demoItem('masala-chai','Masala Chai','Beverages',35,'🍵','#f2e6d3','Beverages','POPULAR',[
    {id:'chai-regular-sugar',group:'Sugar',name:'Regular sugar',priceDeltaMinor:0},
    {id:'chai-less-sugar',group:'Sugar',name:'Less sugar',priceDeltaMinor:0},
    {id:'chai-no-sugar',group:'Sugar',name:'No sugar',priceDeltaMinor:0},
  ]),
  demoItem('lassi','Sweet Lassi','Beverages',80,'🥛','#eee6d8','Beverages'),
  demoItem('masala-chaas','Masala Chaas','Beverages',55,'🥛','#e9e8d9','Beverages'),
  demoItem('mango-shake','Mango Shake','Beverages',110,'🥭','#f2e6ce','Beverages'),
];

/** Who owns outlet setup: this laptop while unpaired, the cloud portal once paired. */
export type SetupMode = 'standalone' | 'cloud';

export type FloorTableStatus = 'free' | 'occupied' | 'bill_printed' | 'ready';

export interface FloorTableView {
  id: string;
  name: string;
  capacity: number;
  sortOrder: number;
  status: FloorTableStatus;
  order: null | {
    id: string;
    orderNumber: string;
    guestCount: number;
    totalMinor: number;
    createdAt: string;
    billPrintedAt: string | null;
  };
}

export interface FloorAreaView {
  id: string;
  name: string;
  sortOrder: number;
  tables: FloorTableView[];
}

export interface FloorView {
  setupMode: SetupMode;
  currency: string;
  areas: FloorAreaView[];
}

export interface TableReportRow {
  tableId: string | null;
  tableName: string;
  areaName: string;
  orderCount: number;
  guestCount: number;
  salesMinor: number;
  averageBillMinor: number;
  averageSeatedMinutes: number;
}

export interface TableReport {
  date: string;
  currency: string;
  tables: TableReportRow[];
  areas: Array<Omit<TableReportRow, 'tableId' | 'tableName'>>;
}
