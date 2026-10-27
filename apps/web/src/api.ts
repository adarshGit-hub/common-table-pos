// Small JSON helpers for the local cashier service. Errors carry the server's message.
export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: 'no-store' });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
  return payload;
}

export async function sendJson<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
  return payload;
}

export const newCommandId = () => crypto.randomUUID();

export function formatMoney(minor: number, currency = 'INR'): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(minor / 100);
}
