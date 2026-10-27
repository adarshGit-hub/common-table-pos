import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { User } from '@supabase/supabase-js';
import { ArrowUpRight, Building2, Check, ChefHat, Copy, LoaderCircle, LogOut, Mail, Monitor, Plus, ShieldCheck, Store } from 'lucide-react';
import { supabase } from './supabase';
import MenuManager from './MenuManager';
import InventoryManager from './InventoryManager';
import CloudReportsView from './CloudReportsView';
import OutletSettings from './OutletSettings';
import TerminalStatusList from './TerminalStatusList';

type Tenant = { tenant_id: string; name: string; created_by: string };
type Membership = { tenant_id: string; role: string; status: string };
type Outlet = { tenant_id: string; outlet_id: string; name: string; timezone: string; currency: string; tax_rate_bps: number; receipt_name: string | null; receipt_address: string | null; receipt_phone: string | null; gstin: string | null; receipt_footer: string | null };
type Terminal = { terminal_id: string; name: string; status: 'active'|'revoked'; enrolled_at: string; last_seen_at: string|null };
type OutletMembership = { tenant_id: string; outlet_id: string; role: string; status: string };
type Role = 'manager' | 'cashier' | 'kitchen' | 'viewer';
const roles: Role[] = ['manager', 'cashier', 'kitchen', 'viewer'];
const fieldClass = 'h-11 w-full rounded-xl border border-[#dfe6df] bg-white px-3 text-sm text-[#263b30] outline-none transition focus:border-[#4a8a61] focus:ring-4 focus:ring-[#4a8a61]/10';
const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#286a4f] px-4 text-sm font-semibold text-white transition hover:bg-[#1f563f] disabled:cursor-not-allowed disabled:opacity-55';

function authRedirectUrl() {
  const configuredOrigin = import.meta.env.VITE_AUTH_REDIRECT_URL?.trim();
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
  let configuredUrl: URL | undefined;
  try {
    if (configuredOrigin) configuredUrl = new URL(configuredOrigin);
  } catch {
    // Ignore malformed build-time configuration and use the current app origin.
  }
  const configuredHost = configuredUrl?.hostname;
  const configuredIsLocal = configuredHost !== undefined
    && ['localhost', '127.0.0.1', '::1'].includes(configuredHost);
  const origin = configuredUrl && !configuredIsLocal
    ? configuredUrl.origin
    : localHost ? 'https://common-table-pos.vercel.app' : window.location.origin;
  return new URL('/admin', origin).toString();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please retry.';
}

function b64url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export default function AdminApp() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [outletMemberships, setOutletMemberships] = useState<OutletMembership[]>([]);
  const [tenantId, setTenantId] = useState('');
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [outletId, setOutletId] = useState('');
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [inviteUrl, setInviteUrl] = useState('');
  const [terminalKey, setTerminalKey] = useState('');
  const [terminalId, setTerminalId] = useState('');
  const [terminalSessionSecret, setTerminalSessionSecret] = useState('');
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', displayName: '' });
  const [setup, setSetup] = useState({
    businessName: 'Indore Mithai House Demo', brandName: 'Indore Mithai House', outletName: 'Vijay Nagar Demo Outlet', timezone: 'Asia/Kolkata', currency: 'INR', taxRateBps: '0',
    receiptName: 'Indore Mithai House · Demo', receiptAddress: 'Vijay Nagar, Indore, Madhya Pradesh · Demo address', receiptPhone: '', gstin: '', diningArea: 'Main floor', tableCount: '8', kitchenStation: 'Main kitchen',
  });
  const [invite, setInvite] = useState({ email: '', role: 'cashier' as Role });
  const [terminalName, setTerminalName] = useState('Counter 01');
  const selectedTenantRole = memberships.find(row => row.tenant_id === tenantId)?.role ?? '';
  const selectedOutletRole = outletMemberships.find(row => row.tenant_id === tenantId && row.outlet_id === outletId)?.role ?? '';
  const canManageOutlet = ['owner', 'manager'].includes(selectedTenantRole) || selectedOutletRole === 'manager';
  const selectedRoleLabel = selectedTenantRole === 'owner' ? 'owner' : selectedOutletRole || selectedTenantRole || 'member';
  const selectedOutlet = outlets.find(row => row.outlet_id === outletId);

  function clearTerminalCredentials() {
    setTerminalId('');
    setTerminalKey('');
    setTerminalSessionSecret('');
  }

  const loadWorkspace = useCallback(async (currentUser: User, preferredTenantId = '') => {
    if (!supabase) return;
    setLoading(true); setError('');
    try {
      const [tenantResult, membershipResult, outletMembershipResult] = await Promise.all([
        supabase.from('tenants').select('tenant_id,name,created_by').order('created_at'),
        supabase.from('tenant_memberships').select('tenant_id,role,status').eq('user_id', currentUser.id).eq('status', 'active'),
        supabase.from('outlet_memberships').select('tenant_id,outlet_id,role,status').eq('user_id', currentUser.id).eq('status', 'active'),
      ]);
      if (tenantResult.error) throw tenantResult.error;
      if (membershipResult.error) throw membershipResult.error;
      if (outletMembershipResult.error) throw outletMembershipResult.error;
      setTenants((tenantResult.data ?? []) as Tenant[]);
      setMemberships((membershipResult.data ?? []) as Membership[]);
      setOutletMemberships((outletMembershipResult.data ?? []) as OutletMembership[]);
      const membershipsForUser = (membershipResult.data ?? []) as Membership[];
      const firstTenantId = preferredTenantId || membershipsForUser[0]?.tenant_id || '';
      setTenantId(firstTenantId);
      if (firstTenantId) {
        const outletResult = await supabase.from('outlets').select('tenant_id,outlet_id,name,timezone,currency,tax_rate_bps,receipt_name,receipt_address,receipt_phone,gstin,receipt_footer').eq('tenant_id', firstTenantId).order('name');
        if (outletResult.error) throw outletResult.error;
        const rows = (outletResult.data ?? []) as Outlet[];
        setOutlets(rows);
        setOutletId((current) => rows.some(row => row.outlet_id === current) ? current : rows[0]?.outlet_id ?? '');
      } else {
        setOutlets([]); setOutletId('');
      }
    } catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!supabase) { setAuthReady(true); return; }
    void supabase.auth.getUser().then(({ data, error: authError }) => {
      if (authError && authError.name !== 'AuthSessionMissingError') setError(authError.message);
      setUser(data.user);
      setAuthReady(true);
      if (data.user) void loadWorkspace(data.user);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUser = session?.user ?? null;
      setUser(nextUser);
      if (nextUser) window.setTimeout(() => void loadWorkspace(nextUser), 0);
      else {
        setTenants([]); setMemberships([]); setOutletMemberships([]); setOutlets([]); setTenantId(''); setOutletId('');
        setTerminalId(''); setTerminalKey(''); setTerminalSessionSecret('');
      }
    });
    return () => listener.subscription.unsubscribe();
  }, [loadWorkspace]);

  const refreshTerminals = useCallback(async () => {
    if (!supabase || !user || !tenantId || !outletId) { setTerminals([]); return; }
    const { data, error: queryError } = await supabase.from('terminals')
      .select('terminal_id,name,status,enrolled_at,last_seen_at')
      .eq('tenant_id', tenantId).eq('outlet_id', outletId).order('enrolled_at', { ascending: false });
    if (queryError) setError(queryError.message);
    else setTerminals((data ?? []) as Terminal[]);
  }, [user, tenantId, outletId]);

  useEffect(() => {
    if (!supabase || !user || !tenantId || !outletId) { setTerminals([]); return; }
    void refreshTerminals();
    const timer = window.setInterval(() => void refreshTerminals(), 15_000);
    return () => window.clearInterval(timer);
  }, [user, tenantId, outletId, refreshTerminals]);

  useEffect(() => {
    const inviteToken = new URLSearchParams(window.location.search).get('invite');
    if (!inviteToken || !user || !supabase) return;
    setLoading(true); setError(''); setNotice('Checking your staff invitation…');
    void supabase.functions.invoke('manage-staff', { body: { action: 'accept_invite', token: inviteToken } })
      .then(({ data, error: functionError }) => {
        if (functionError) throw functionError;
        setNotice(`Invitation accepted. You’re now assigned to ${data?.outletName ?? data?.tenantName ?? 'the POS account'}.`);
        window.history.replaceState({}, '', '/admin');
        return loadWorkspace(user);
      })
      .catch(cause => setError(messageOf(cause)))
      .finally(() => setLoading(false));
  }, [user, loadWorkspace]);

  async function submitAuth(event: FormEvent) {
    event.preventDefault(); if (!supabase) return;
    setLoading(true); setError(''); setNotice('');
    try {
      if (authMode === 'signup') {
        const { data, error: authError } = await supabase.auth.signUp({
          email: form.email.trim(), password: form.password,
          options: {
            emailRedirectTo: authRedirectUrl(),
            data: { display_name: form.displayName.trim() },
          },
        });
        if (authError) throw authError;
        if (data.session) { setUser(data.user); setNotice('Your account is ready. Set up your first outlet below.'); }
        else setNotice('Check your email to confirm the account, then sign in here.');
      } else {
        const { data, error: authError } = await supabase.auth.signInWithPassword({ email: form.email.trim(), password: form.password });
        if (authError) throw authError;
        setUser(data.user); await loadWorkspace(data.user);
      }
    } catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); }
  }

  async function sendMagicLink() {
    if (!supabase || !form.email.trim()) { setError('Enter your email address first.'); return; }
    setLoading(true); setError(''); setNotice(''); setMagicLinkSent(false);
    try {
      const { error: authError } = await supabase.auth.signInWithOtp({
        email: form.email.trim(),
        options: {
          shouldCreateUser: true,
          emailRedirectTo: authRedirectUrl(),
          data: { display_name: form.displayName.trim() || 'Demo Owner' },
        },
      });
      if (authError) throw authError;
      setMagicLinkSent(true);
      setNotice('A secure sign-in link was requested. Check your inbox, then open the link on this device to continue outlet setup.');
    } catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); }
  }

  async function createOutlet(event: FormEvent) {
    event.preventDefault(); if (!supabase || !user) return;
    setLoading(true); setError(''); setNotice('');
    try {
      // Each insert is protected by RLS. If a later step fails, the created tenant remains owned by this user and can be resumed on retry.
      const tenantResult = await supabase.from('tenants').insert({ name: setup.businessName.trim(), created_by: user.id }).select('tenant_id').single();
      if (tenantResult.error) throw tenantResult.error;
      const tid = tenantResult.data.tenant_id as string;
      const memberResult = await supabase.from('tenant_memberships').insert({ tenant_id: tid, user_id: user.id, role: 'owner', status: 'active' });
      if (memberResult.error) throw memberResult.error;
      const brandResult = await supabase.from('brands').insert({ tenant_id: tid, name: setup.brandName.trim() || setup.businessName.trim() }).select('brand_id').single();
      if (brandResult.error) throw brandResult.error;
      const outletResult = await supabase.from('outlets').insert({
        tenant_id: tid, brand_id: brandResult.data.brand_id, name: setup.outletName.trim(), timezone: setup.timezone,
        currency: setup.currency.trim().toUpperCase(), tax_rate_bps: Number(setup.taxRateBps), receipt_name: setup.receiptName.trim() || null,
        receipt_address: setup.receiptAddress.trim() || null, receipt_phone: setup.receiptPhone.trim() || null, gstin: setup.gstin.trim().toUpperCase() || null,
      }).select('outlet_id').single();
      if (outletResult.error) throw outletResult.error;
      const oid = outletResult.data.outlet_id as string;
      const outletMemberResult = await supabase.from('outlet_memberships').insert({ tenant_id: tid, outlet_id: oid, user_id: user.id, role: 'manager', status: 'active' });
      if (outletMemberResult.error) throw outletMemberResult.error;
      const areaResult = await supabase.from('dining_areas').insert({ tenant_id: tid, outlet_id: oid, name: setup.diningArea.trim() || 'Main floor' }).select('area_id').single();
      if (areaResult.error) throw areaResult.error;
      const tableCount = Math.max(1, Math.min(50, Math.floor(Number(setup.tableCount) || 8)));
      const tableRows = Array.from({ length: tableCount }, (_, index) => ({ tenant_id: tid, outlet_id: oid, area_id: areaResult.data.area_id, name: `Table ${String(index + 1).padStart(2, '0')}`, capacity: 2, sort_order: index }));
      const tablesResult = await supabase.from('dining_tables').insert(tableRows);
      if (tablesResult.error) throw tablesResult.error;
      const stationResult = await supabase.from('kitchen_stations').insert({ tenant_id: tid, outlet_id: oid, name: setup.kitchenStation.trim() || 'Main kitchen' });
      if (stationResult.error) throw stationResult.error;
      setNotice('Outlet created. Add staff and enroll the cashier or kitchen terminals below.');
      setTenantId(tid); await loadWorkspace(user, tid);
    } catch (cause) { setError(messageOf(cause)); await loadWorkspace(user); }
    finally { setLoading(false); }
  }

  async function createInvite(event: FormEvent) {
    event.preventDefault(); if (!supabase || !tenantId || !outletId) return;
    setLoading(true); setError(''); setNotice(''); setInviteUrl('');
    try {
      const { data, error: functionError } = await supabase.functions.invoke('manage-staff', {
        body: { action: 'create_invite', tenantId, outletId, email: invite.email.trim(), role: invite.role },
      });
      if (functionError) throw functionError;
      const url = `${window.location.origin}/admin?invite=${encodeURIComponent(data.token)}`;
      setInviteUrl(url); await navigator.clipboard?.writeText(url);
      setNotice('Invite created and copied. Send the one-time link to the staff member; they must verify the invited email before accepting.');
    } catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); }
  }

  async function enrollTerminal(event: FormEvent) {
    event.preventDefault(); if (!supabase || !user || !tenantId || !outletId) return;
    setLoading(true); setError(''); setNotice(''); setTerminalKey(''); setTerminalId(''); setTerminalSessionSecret('');
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const rawKey = b64url(bytes);
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawKey));
      const keyHash = b64url(new Uint8Array(hash));
      const { data: terminal, error: insertError } = await supabase.from('terminals').insert({
        tenant_id: tenantId, outlet_id: outletId, name: terminalName.trim(), device_key_hash: keyHash, enrolled_by: user.id,
      }).select('terminal_id').single();
      if (insertError) throw insertError;
      setTerminalId(terminal.terminal_id as string); setTerminalKey(rawKey);
      setNotice('Terminal enrolled. Save this one-time key in the outlet edge configuration now; it cannot be retrieved later.');
    } catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); }
  }

  async function copyTerminalConfiguration() {
    const tenant = tenants.find(row => row.tenant_id === tenantId);
    const outlet = outlets.find(row => row.outlet_id === outletId);
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
    const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
    if (!user || !tenant || !outlet || !terminalId || !terminalKey || !supabaseUrl || !publishableKey) {
      setError('The outlet, terminal, or browser-safe Supabase settings are missing. Refresh the manager page and retry.');
      return;
    }
    const safe = (value: string) => value.replace(/[\r\n]/g, ' ').trim();
    const envValue = (value: string) => `"${safe(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const sessionSecret = terminalSessionSecret || `${crypto.randomUUID()}${crypto.randomUUID()}`;
    setTerminalSessionSecret(sessionSecret);
    const config = [
      `VITE_SUPABASE_URL=${envValue(supabaseUrl)}`,
      `VITE_SUPABASE_PUBLISHABLE_KEY=${envValue(publishableKey)}`,
      `POS_TENANT_ID=${tenantId}`,
      `POS_TENANT_NAME=${envValue(tenant.name)}`,
      `POS_OUTLET_ID=${outletId}`,
      `POS_OUTLET_NAME=${envValue(outlet.name)}`,
      `POS_TERMINAL_ID=${terminalId}`,
      `POS_TERMINAL_NAME=${envValue(terminalName)}`,
      `POS_ACTOR_ID=${user.id}`,
      `POS_TIMEZONE=${outlet.timezone}`,
      `POS_CURRENCY=${outlet.currency}`,
      `POS_TAX_RATE_BPS=${outlet.tax_rate_bps}`,
      `POS_SESSION_SECRET=${sessionSecret}`,
      `POS_SYNC_URL=${supabaseUrl.replace(/\/$/, '')}/functions/v1/pos-sync`,
      `POS_TERMINAL_KEY=${terminalKey}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(config);
      setNotice('Edge configuration copied. Paste it into the outlet server’s private .env, then rebuild the edge app.');
    } catch {
      setError('The browser could not access the clipboard. Copy the terminal key and required settings into the private edge .env manually.');
    }
  }

  async function revokeTerminal(terminal: Terminal) {
    if (!supabase || !tenantId || !outletId || terminal.status !== 'active') return;
    if (!window.confirm(`Revoke ${terminal.name}? This terminal will stop syncing immediately.`)) return;
    setLoading(true); setError(''); setNotice('');
    try {
      const { error: revokeError } = await supabase.from('terminals').update({ status: 'revoked' })
        .eq('tenant_id', tenantId).eq('outlet_id', outletId).eq('terminal_id', terminal.terminal_id);
      if (revokeError) throw revokeError;
      if (terminalId === terminal.terminal_id) clearTerminalCredentials();
      setTerminals(previous => previous.map(row => row.terminal_id === terminal.terminal_id ? { ...row, status: 'revoked' } : row));
      setNotice(`${terminal.name} revoked. Its sync key can no longer authenticate.`);
    } catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); }
  }

  async function changeTenant(nextId: string) {
    clearTerminalCredentials();
    setTenantId(nextId); setOutletId('');
    if (!supabase) return;
    const { data, error: queryError } = await supabase.from('outlets').select('tenant_id,outlet_id,name,timezone,currency,tax_rate_bps,receipt_name,receipt_address,receipt_phone,gstin,receipt_footer').eq('tenant_id', nextId).order('name');
    if (queryError) setError(queryError.message);
    else { const rows = (data ?? []) as Outlet[]; setOutlets(rows); setOutletId(rows[0]?.outlet_id ?? ''); }
  }

  if (!supabase) return <main className="grid min-h-screen place-items-center bg-[#f3f6f2] p-5"><div className="max-w-lg rounded-3xl border border-[#e4ebe4] bg-white p-8 shadow-sm"><h1 className="text-2xl font-bold text-[#263c30]">Manager portal is not configured</h1><p className="mt-3 text-sm leading-6 text-[#65746b]">Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> in the local or Vercel environment, then rebuild.</p><a className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-[#28714f]" href="/">Open the POS preview <ArrowUpRight size={15}/></a></div></main>;

  return <main className="min-h-screen bg-[#f3f6f2] text-[#263c30]">
    <header className="border-b border-[#e3e9e3] bg-white"><div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4"><a className="flex items-center gap-3" href="/admin"><span className="grid size-10 place-items-center rounded-xl bg-[#eaf3eb] text-[#2b7452]"><Store size={19}/></span><span><strong className="block text-sm">Common Table</strong><small className="block text-xs text-[#819087]">Outlet setup</small></span></a>{user&&<div className="flex items-center gap-3"><span className="hidden text-right sm:block"><strong className="block text-xs">{user.user_metadata?.display_name||user.email}</strong><small className="text-xs text-[#819087]">{user.email}</small></span><button className="grid size-10 place-items-center rounded-xl border border-[#e4eae4] text-[#607067] hover:bg-[#f3f6f2]" title="Sign out" onClick={()=>void supabase?.auth.signOut()}><LogOut size={17}/></button></div>}</div></header>
    <div className="mx-auto max-w-6xl px-5 py-9">
      {!authReady||loading&& !user?<div className="grid min-h-64 place-items-center"><LoaderCircle className="animate-spin text-[#38805a]" size={28}/></div>:!user?<div className="mx-auto max-w-md rounded-3xl border border-[#e1e8e1] bg-white p-7 shadow-sm sm:p-9"><span className="grid size-12 place-items-center rounded-2xl bg-[#edf5ee] text-[#317452]"><ShieldCheck size={23}/></span><h1 className="mt-5 text-2xl font-bold">{authMode==='signup'?'Create your manager account':'Sign in to manage outlets'}</h1><p className="mt-2 text-sm leading-6 text-[#718077]">Use Supabase Auth. Staff access is scoped by tenant, outlet, and role.</p>{error&&<div role="alert" className="mt-4 rounded-xl border border-[#f1c8c0] bg-[#fff4f1] px-4 py-3 text-sm text-[#9a493d]">{error}</div>}{notice&&<div role="status" className="mt-4 rounded-xl border border-[#cfe3d2] bg-[#f0f8f1] px-4 py-3 text-sm text-[#356d49]">{notice}</div>}<form className="mt-6 space-y-4" onSubmit={submitAuth}>{authMode==='signup'&&<label className="block text-sm font-medium">Your name<input className={`${fieldClass} mt-1.5`} autoComplete="name" required value={form.displayName} onChange={e=>setForm({...form,displayName:e.target.value})}/></label>}<label className="block text-sm font-medium">Email<input className={`${fieldClass} mt-1.5`} type="email" autoComplete="email" required value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/></label><label className="block text-sm font-medium">Password<input className={`${fieldClass} mt-1.5`} type="password" minLength={10} autoComplete={authMode==='signup'?'new-password':'current-password'} required value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/></label><button className={`${buttonClass} w-full`} disabled={loading}>{loading?<LoaderCircle className="animate-spin" size={16}/>:authMode==='signup'?'Create account':'Sign in'}</button></form>{authMode==='signin'&&<><div className="my-4 flex items-center gap-3 text-[11px] text-[#98a39b]"><span className="h-px flex-1 bg-[#e8ede8]"/>or<span className="h-px flex-1 bg-[#e8ede8]"/></div><button type="button" className="w-full rounded-xl border border-[#dfe7df] bg-white px-4 py-3 text-sm font-semibold text-[#337451] hover:bg-[#f6f9f6] disabled:opacity-60" disabled={loading||magicLinkSent} onClick={()=>void sendMagicLink()}>{loading?<LoaderCircle className="mr-2 inline animate-spin" size={15}/>:<Mail className="mr-2 inline" size={15}/>}Email me a secure sign-in link</button></>}<button className="mt-5 w-full text-center text-sm font-semibold text-[#337451]" onClick={()=>{setAuthMode(authMode==='signup'?'signin':'signup');setError('');setNotice('');}}>{authMode==='signup'?'Already registered? Sign in':'New to Common Table? Create a manager account'}</button><p className="mt-5 text-center text-xs leading-5 text-[#8a968f]">Staff invitations require a verified email address. Passwords are handled by Supabase Auth.</p></div>:<>
        <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-[#79887f]">Control plane</p><h1 className="mt-2 text-3xl font-bold tracking-tight">Your outlets</h1><p className="mt-2 text-sm text-[#718077]">Set outlet identity and access before connecting the local POS edge.</p></div>{tenants.length>1&&<label className="text-sm font-medium">Business<select aria-label="Select business account" className={`${fieldClass} mt-1.5 max-w-xs`} value={tenantId} onChange={e=>void changeTenant(e.target.value)}>{tenants.filter(t=>memberships.some(m=>m.tenant_id===t.tenant_id)).map(t=><option key={t.tenant_id} value={t.tenant_id}>{t.name}</option>)}</select></label>}</div>
        {error&&<div role="alert" className="mt-5 rounded-xl border border-[#f1c8c0] bg-[#fff4f1] px-4 py-3 text-sm text-[#9a493d]">{error}</div>}{notice&&<div role="status" className="mt-5 rounded-xl border border-[#cfe3d2] bg-[#f0f8f1] px-4 py-3 text-sm text-[#356d49]">{notice}</div>}
        {!tenantId?<form onSubmit={createOutlet} className="mt-7 grid gap-5 lg:grid-cols-[1fr_1.1fr]"><section className="rounded-2xl border border-[#e1e8e1] bg-white p-6"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-[#eef5ee] text-[#347352]"><Building2 size={19}/></span><div><h2 className="font-bold">Business account</h2><p className="text-xs text-[#839087]">This is your tenant and first outlet owner.</p></div></div><div className="mt-5 space-y-4"><label className="block text-sm font-medium">Business name<input className={`${fieldClass} mt-1.5`} required maxLength={120} placeholder="Common Table Hospitality" value={setup.businessName} onChange={e=>setSetup({...setup,businessName:e.target.value})}/></label><label className="block text-sm font-medium">Brand name<input className={`${fieldClass} mt-1.5`} maxLength={120} placeholder="Juniper Café" value={setup.brandName} onChange={e=>setSetup({...setup,brandName:e.target.value})}/></label><label className="block text-sm font-medium">First outlet name<input className={`${fieldClass} mt-1.5`} required maxLength={120} placeholder="Indore Vijay Nagar" value={setup.outletName} onChange={e=>setSetup({...setup,outletName:e.target.value})}/></label><div className="grid grid-cols-2 gap-3"><label className="block text-sm font-medium">Timezone<input className={`${fieldClass} mt-1.5`} required value={setup.timezone} onChange={e=>setSetup({...setup,timezone:e.target.value})}/></label><label className="block text-sm font-medium">Currency<input className={`${fieldClass} mt-1.5`} required maxLength={3} value={setup.currency} onChange={e=>setSetup({...setup,currency:e.target.value.toUpperCase()})}/></label></div><label className="block text-sm font-medium">Tax rate (basis points)<input className={`${fieldClass} mt-1.5`} type="number" min={0} max={10000} step={1} value={setup.taxRateBps} onChange={e=>setSetup({...setup,taxRateBps:e.target.value})}/><small className="mt-1 block font-normal text-[#89958d]">Example: 500 = 5%. Confirm actual tax treatment with your accountant.</small></label></div></section>
          <section className="rounded-2xl border border-[#e1e8e1] bg-white p-6"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-[#f7f2e8] text-[#937a49]"><ChefHat size={19}/></span><div><h2 className="font-bold">Outlet details</h2><p className="text-xs text-[#839087]">Receipt identity and service layout.</p></div></div><div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="block text-sm font-medium">Receipt name<input className={`${fieldClass} mt-1.5`} value={setup.receiptName} onChange={e=>setSetup({...setup,receiptName:e.target.value})}/></label><label className="block text-sm font-medium">Receipt phone<input className={`${fieldClass} mt-1.5`} type="tel" value={setup.receiptPhone} onChange={e=>setSetup({...setup,receiptPhone:e.target.value})}/></label><label className="block text-sm font-medium sm:col-span-2">Receipt address<textarea className="mt-1.5 min-h-20 w-full rounded-xl border border-[#dfe6df] bg-white p-3 text-sm outline-none focus:border-[#4a8a61]" value={setup.receiptAddress} onChange={e=>setSetup({...setup,receiptAddress:e.target.value})}/></label><label className="block text-sm font-medium">GSTIN (optional)<input className={`${fieldClass} mt-1.5`} maxLength={15} value={setup.gstin} onChange={e=>setSetup({...setup,gstin:e.target.value.toUpperCase()})}/></label><label className="block text-sm font-medium">Dining area<input className={`${fieldClass} mt-1.5`} required value={setup.diningArea} onChange={e=>setSetup({...setup,diningArea:e.target.value})}/></label><label className="block text-sm font-medium">Number of tables<input className={`${fieldClass} mt-1.5`} type="number" min={1} max={50} value={setup.tableCount} onChange={e=>setSetup({...setup,tableCount:e.target.value})}/></label><label className="block text-sm font-medium">Kitchen station<input className={`${fieldClass} mt-1.5`} required value={setup.kitchenStation} onChange={e=>setSetup({...setup,kitchenStation:e.target.value})}/></label></div><button className={`${buttonClass} mt-6 w-full sm:w-auto`} disabled={loading}>{loading?<LoaderCircle className="animate-spin" size={16}/>:<Plus size={16}/>}Create business and outlet</button></section>
        </form>:<><div className="mt-7 grid gap-5 lg:grid-cols-[1fr_1fr]"><div className="space-y-5"><section className="rounded-2xl border border-[#e1e8e1] bg-white p-6"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-[#eef5ee] text-[#347352]"><Store size={19}/></span><div><h2 className="font-bold">{tenants.find(t=>t.tenant_id===tenantId)?.name??'Business'}</h2><p className="text-xs text-[#839087]">{outlets.length} outlet{outlets.length===1?'':'s'} · {selectedRoleLabel}</p></div></div></div><div className="mt-5 space-y-2">{outlets.map(outlet=><button key={outlet.outlet_id} onClick={()=>{clearTerminalCredentials();setOutletId(outlet.outlet_id)}} className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left ${outletId===outlet.outlet_id?'border-[#9bc4a4] bg-[#f2f8f2]':'border-[#e6ebe6] hover:bg-[#f8faf8]'}`}><span className="grid size-9 place-items-center rounded-lg bg-white text-[#568269]"><Store size={16}/></span><span className="flex-1"><strong className="block text-sm">{outlet.name}</strong><small className="text-xs text-[#849188]">{outlet.timezone} · {outlet.currency} · {Number(outlet.tax_rate_bps)/100}% demo/configured tax</small></span>{outletId===outlet.outlet_id&&<Check size={17} className="text-[#39835a}"/>}</button>)}{outlets.length===0&&<p className="rounded-xl bg-[#f5f7f5] p-4 text-sm text-[#728077]">This account has no active outlets yet.</p>}</div><p className="mt-5 rounded-xl bg-[#f8f5ed] p-3 text-xs leading-5 text-[#8a7857]">Orders are accepted by the outlet’s local SQLite edge. Its durable sync queue sends business events to the cloud when the connection is available.</p></section>{selectedOutlet&&<OutletSettings key={selectedOutlet.outlet_id} outlet={selectedOutlet} canEdit={canManageOutlet} onSaved={updated=>setOutlets(current=>current.map(row=>row.outlet_id===updated.outlet_id?updated:row))}/>}</div>
          {canManageOutlet?<div className="space-y-5"><section className="rounded-2xl border border-[#e1e8e1] bg-white p-6"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-[#f2effa] text-[#725d9c]"><Mail size={18}/></span><div><h2 className="font-bold">Invite staff</h2><p className="text-xs text-[#839087]">Create a scoped, expiring invite link.</p></div></div><form className="mt-5 grid gap-3 sm:grid-cols-[1fr_150px_auto]" onSubmit={createInvite}><input className={fieldClass} type="email" required placeholder="staff@example.com" value={invite.email} onChange={e=>setInvite({...invite,email:e.target.value})}/><select className={fieldClass} value={invite.role} onChange={e=>setInvite({...invite,role:e.target.value as Role})}>{roles.map(role=><option key={role} value={role}>{role}</option>)}</select><button className={buttonClass} disabled={loading||!outletId}>{loading?<LoaderCircle className="animate-spin" size={16}/>:<Mail size={16}/>}Create invite</button></form>{inviteUrl&&<div className="mt-3 flex gap-2 rounded-xl bg-[#f5f8f4] p-3"><code className="min-w-0 flex-1 break-all text-xs text-[#567060]">{inviteUrl}</code><button className="grid size-9 shrink-0 place-items-center rounded-lg border border-[#dfe8df] bg-white" title="Copy invite" onClick={()=>void navigator.clipboard?.writeText(inviteUrl)}><Copy size={15}/></button></div>}</section>
          <section className="rounded-2xl border border-[#e1e8e1] bg-white p-6"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-[#edf3f7] text-[#587c98]"><Monitor size={18}/></span><div><h2 className="font-bold">Enroll a terminal</h2><p className="text-xs text-[#839087]">The device key is shown once.</p></div></div><form className="mt-5 flex gap-3" onSubmit={enrollTerminal}><input className={fieldClass} required maxLength={100} value={terminalName} onChange={e=>setTerminalName(e.target.value)}/><button className={buttonClass} disabled={loading||!outletId}>{loading?<LoaderCircle className="animate-spin" size={16}/>:<Plus size={16}/>}Enroll</button></form>{terminalKey&&<div className="mt-3 rounded-xl border border-[#f0e2bb] bg-[#fffaf0] p-3"><p className="text-xs font-semibold text-[#806a38]">Terminal ID · {terminalId}</p><p className="mt-2 text-[11px] font-semibold text-[#806a38]">Store this key in the outlet edge configuration</p><code className="mt-2 block break-all text-xs text-[#655637]">{terminalKey}</code><button type="button" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[#50704f]" onClick={()=>void navigator.clipboard?.writeText(terminalKey)}><Copy size={13}/>Copy key</button><button type="button" className="mt-2 ml-4 inline-flex items-center gap-1 text-xs font-semibold text-[#50704f]" onClick={()=>void copyTerminalConfiguration()}><Copy size={13}/>Copy edge config</button></div>}<TerminalStatusList terminals={terminals} disabled={loading} onRevoke={record => { const terminal=terminals.find(item=>item.terminal_id===record.terminal_id); if(terminal) void revokeTerminal(terminal); }} /><p className="mt-4 text-xs leading-5 text-[#87938b]">The cloud stores only a hash of the terminal key. Copy the one-time config to the outlet server’s private <code>.env</code> and start the edge service. Its first authenticated menu sync verifies pairing and updates Last seen here within 15 seconds. A terminal is marked offline after 90 seconds without a check-in. Revoked keys stop syncing.</p></section></div>:<p className="rounded-2xl border border-[#e1e8e1] bg-white p-6 text-sm leading-6 text-[#718077]">Your assigned outlet role can view its workspace. Contact an outlet manager for staff or terminal administration.</p>}
        </div><div className="mt-5">{outletId&&canManageOutlet&&<MenuManager tenantId={tenantId} outletId={outletId} currency={outlets.find(row=>row.outlet_id===outletId)?.currency??'INR'}/>}</div>{outletId&&canManageOutlet&&user&&<InventoryManager key={tenantId+':'+outletId} tenantId={tenantId} outletId={outletId} userId={user.id}/>}{outletId&&canManageOutlet&&<CloudReportsView tenantId={tenantId} outletId={outletId} outletName={outlets.find(row=>row.outlet_id===outletId)?.name??'Selected outlet'} timeZone={outlets.find(row=>row.outlet_id===outletId)?.timezone} currency={outlets.find(row=>row.outlet_id===outletId)?.currency??'INR'}/>}</>}
      </>}
      <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-[#e1e8e1] py-5 text-xs text-[#86928a]"><span>Common Table POS · manager tools</span><a className="inline-flex items-center gap-1 font-semibold text-[#467358]" href="/">Return to the POS preview <ArrowUpRight size={13}/></a></footer>
    </div>
  </main>;
}
