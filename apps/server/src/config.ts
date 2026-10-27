function setting(name: string, developmentFallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (process.env.NODE_ENV !== 'production' && developmentFallback) return developmentFallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

function integerSetting(name: string, developmentFallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined && process.env.NODE_ENV !== 'production' ? developmentFallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

export const EDGE_CONFIG = {
  tenantId: setting('POS_TENANT_ID', 'tenant-common-table-demo'),
  tenantName: setting('POS_TENANT_NAME', 'Indore Mithai House Demo'),
  outletId: setting('POS_OUTLET_ID', 'outlet-vijay-nagar-demo'),
  outletName: setting('POS_OUTLET_NAME', 'Vijay Nagar Demo Outlet'),
  terminalId: setting('POS_TERMINAL_ID', 'terminal-counter-01'),
  terminalName: setting('POS_TERMINAL_NAME', 'Counter 01'),
  locationLabel: setting('POS_LOCATION_LABEL', 'Vijay Nagar, Indore · Demo'),
  receiptName: process.env.POS_RECEIPT_NAME?.trim() ?? '',
  receiptAddress: process.env.POS_RECEIPT_ADDRESS?.trim() ?? '',
  receiptPhone: process.env.POS_RECEIPT_PHONE?.trim() ?? '',
  gstin: process.env.POS_GSTIN?.trim().toUpperCase() ?? '',
  receiptFooter: process.env.POS_RECEIPT_FOOTER?.trim() ?? '',
  actorId: setting('POS_ACTOR_ID', 'demo-owner'),
  timezone: setting('POS_TIMEZONE', 'Asia/Kolkata'),
  currency: setting('POS_CURRENCY', 'INR'),
  taxRateBps: integerSetting('POS_TAX_RATE_BPS', Number(process.env.DEMO_TAX_RATE_BPS ?? 500)),
  sessionSecret: setting('POS_SESSION_SECRET', 'common-table-development-session-secret'),
  supabaseUrl: process.env.VITE_SUPABASE_URL?.trim() ?? '',
  supabasePublishableKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '',
  secureSessionCookie: process.env.POS_COOKIE_SECURE?.trim() === 'true' || (process.env.NODE_ENV === 'production' && process.env.POS_COOKIE_SECURE?.trim() !== 'false'),
};

export interface OutletRuntimeSettings {
  name: string;
  timezone: string;
  currency: string;
  taxRateBps: number;
  receiptName: string;
  receiptAddress: string;
  receiptPhone: string;
  gstin: string;
  receiptFooter: string;
}

function receiptText(row: Record<string, unknown>, field: string, maxLength: number, fallback: string): string {
  if (!(field in row)) return fallback;
  const raw = row[field];
  if (raw === null) return '';
  if (typeof raw !== 'string') throw new Error(`The cloud outlet ${field} is invalid.`);
  const value = raw.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if (value.length > maxLength) throw new Error(`The cloud outlet ${field} is invalid.`);
  return value;
}

export function parseOutletRuntimeSettings(value: unknown): OutletRuntimeSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The cloud outlet settings are invalid.');
  const row = value as Record<string, unknown>;
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  const timezone = typeof row.timezone === 'string' ? row.timezone.trim() : '';
  const currency = typeof row.currency === 'string' ? row.currency.trim().toUpperCase() : '';
  const taxRateBps = Number(row.taxRateBps);
  const receiptName = receiptText(row, 'receiptName', 120, EDGE_CONFIG.receiptName);
  const receiptAddress = receiptText(row, 'receiptAddress', 240, EDGE_CONFIG.receiptAddress);
  const receiptPhone = receiptText(row, 'receiptPhone', 40, EDGE_CONFIG.receiptPhone);
  const gstin = receiptText(row, 'gstin', 15, EDGE_CONFIG.gstin).toUpperCase();
  const receiptFooter = receiptText(row, 'receiptFooter', 240, EDGE_CONFIG.receiptFooter);
  if (!name || name.length > 120) throw new Error('The cloud outlet name is invalid.');
  if (!timezone || timezone.length > 80) throw new Error('The cloud outlet timezone is invalid.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
  catch { throw new Error('The cloud outlet timezone is invalid.'); }
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('The cloud outlet currency is invalid.');
  if (!Number.isSafeInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > 10_000) throw new Error('The cloud outlet tax rate is invalid.');
  if (gstin && !/^[0-9A-Z]{15}$/.test(gstin)) throw new Error('The cloud outlet GSTIN is invalid.');
  return { name, timezone, currency, taxRateBps, receiptName, receiptAddress, receiptPhone, gstin, receiptFooter };
}

export function applyOutletRuntimeSettings(value: unknown): OutletRuntimeSettings {
  const settings = parseOutletRuntimeSettings(value);
  EDGE_CONFIG.outletName = settings.name;
  EDGE_CONFIG.timezone = settings.timezone;
  EDGE_CONFIG.currency = settings.currency;
  EDGE_CONFIG.taxRateBps = settings.taxRateBps;
  EDGE_CONFIG.receiptName = settings.receiptName;
  EDGE_CONFIG.receiptAddress = settings.receiptAddress;
  EDGE_CONFIG.receiptPhone = settings.receiptPhone;
  EDGE_CONFIG.gstin = settings.gstin;
  EDGE_CONFIG.receiptFooter = settings.receiptFooter;
  return settings;
}

const configuredSupabaseUrl = (process.env.POS_SYNC_URL?.trim()
  ?? `${(process.env.VITE_SUPABASE_URL ?? '').trim().replace(/\/$/, '')}/functions/v1/pos-sync`).trim();
export const SYNC_CONFIG = Object.freeze({
  url: configuredSupabaseUrl === '/functions/v1/pos-sync' ? '' : configuredSupabaseUrl,
  terminalKey: process.env.POS_TERMINAL_KEY?.trim() ?? '',
});

export function checkEdgeConfiguration(): void {
  const required: Array<keyof typeof EDGE_CONFIG> = [
    'tenantId', 'tenantName', 'outletId', 'outletName', 'terminalId', 'terminalName', 'actorId', 'timezone', 'currency',
  ];
  if (required.some((key) => !EDGE_CONFIG[key])) throw new Error('Outlet configuration is incomplete.');
  if (!/^[A-Z]{3}$/.test(EDGE_CONFIG.currency)) throw new Error('POS_CURRENCY must be a three-letter ISO currency code.');
  if (EDGE_CONFIG.sessionSecret.length < 32) throw new Error('POS_SESSION_SECRET must contain at least 32 characters.');
  const hasSupabaseUrl=Boolean(EDGE_CONFIG.supabaseUrl);
  const hasSupabaseKey=Boolean(EDGE_CONFIG.supabasePublishableKey);
  if (hasSupabaseUrl!==hasSupabaseKey) throw new Error('Configure both the Supabase Auth URL and publishable key.');
  if (process.env.NODE_ENV==='production'&&(!hasSupabaseUrl||!hasSupabaseKey))
    throw new Error('Supabase Auth URL and publishable key are required in production.');
}

/** Paired terminals take outlet setup from the cloud; unpaired ones own it locally. */
export function setupMode(): 'standalone' | 'cloud' {
  return SYNC_CONFIG.url && SYNC_CONFIG.terminalKey ? 'cloud' : 'standalone';
}
