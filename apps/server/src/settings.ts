// Operational settings kept on this laptop: discount limit, service charge and
// kitchen quick notes. Outlet identity (name, receipt, GSTIN) lives on the outlets row.
import { edgeSetting, setEdgeSetting } from './database.js';

export interface OperationalSettings {
  /** Largest discount a cashier may give, as a share of the discounted amount. */
  cashierDiscountLimitBps: number;
  /** Optional dine-in service charge; 0 turns it off. */
  serviceChargeBps: number;
  /** Printed when an item has no HSN/SAC code of its own (restaurant service). */
  defaultSac: string;
  quickNotes: string[];
}

const DEFAULTS: OperationalSettings = {
  cashierDiscountLimitBps: 1000, serviceChargeBps: 0, defaultSac: '996331',
  quickNotes: ['No onion', 'No garlic', 'Jain', 'Less spicy', 'Extra spicy', 'Parcel'],
};

export function operationalSettings(): OperationalSettings {
  try {
    const stored = JSON.parse(edgeSetting('operational_settings') ?? '{}') as Partial<OperationalSettings>;
    return { ...DEFAULTS, ...stored };
  } catch { return { ...DEFAULTS }; }
}

/** Validates a partial update and returns the merged settings, or an error message. */
export function mergeOperationalSettings(patch: Record<string, unknown>): OperationalSettings | string {
  const next = { ...operationalSettings() };
  if (patch.cashierDiscountLimitBps !== undefined) {
    const value = Number(patch.cashierDiscountLimitBps);
    if (!Number.isSafeInteger(value) || value < 0 || value > 10000) return 'Cashier discount limit must be between 0% and 100%.';
    next.cashierDiscountLimitBps = value;
  }
  if (patch.serviceChargeBps !== undefined) {
    const value = Number(patch.serviceChargeBps);
    if (!Number.isSafeInteger(value) || value < 0 || value > 2000) return 'Service charge must be between 0% and 20%.';
    next.serviceChargeBps = value;
  }
  if (patch.defaultSac !== undefined) {
    if (typeof patch.defaultSac !== 'string' || !/^[0-9]{4,8}$/.test(patch.defaultSac.trim())) return 'Default HSN/SAC must be 4 to 8 digits.';
    next.defaultSac = patch.defaultSac.trim();
  }
  if (patch.quickNotes !== undefined) {
    if (!Array.isArray(patch.quickNotes) || patch.quickNotes.length > 20
      || patch.quickNotes.some(note => typeof note !== 'string' || !note.trim() || note.trim().length > 30)) return 'Quick notes must be up to 20 entries of 1-30 characters.';
    next.quickNotes = [...new Set((patch.quickNotes as string[]).map(note => note.trim()))];
  }
  return next;
}

export function saveOperationalSettings(settings: OperationalSettings): void {
  setEdgeSetting('operational_settings', JSON.stringify(settings));
}
