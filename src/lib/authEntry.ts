/**
 * Query keys that must keep loading the existing auth/application bundle after
 * the public homepage was split into a lightweight prerendered route.
 *
 * Keep this list shared by the router and the application so a Supabase
 * callback/error never lands on the marketing homepage instead of AuthPage.
 */
export const AUTH_CALLBACK_QUERY_KEYS = [
  'auth',
  'recovery',
  'invite',
  'code',
  'access_token',
  'error',
  'error_description',
  'error_code',
  'passwordUpdated',
] as const;

export function hasAuthCallbackQuery(search: string): boolean {
  const query = new URLSearchParams(search || '');
  return AUTH_CALLBACK_QUERY_KEYS.some((key) => query.has(key));
}

/** Supabase implicit-grant callbacks and redirect errors arrive in the fragment. */
export const AUTH_CALLBACK_FRAGMENT_KEYS = [
  'type',
  'access_token',
  'refresh_token',
  'code',
  'error',
  'error_description',
  'error_code',
] as const;

export function hasAuthCallbackFragment(hash: string): boolean {
  const fragment = new URLSearchParams((hash || '').replace(/^#/, ''));
  return AUTH_CALLBACK_FRAGMENT_KEYS.some((key) => fragment.has(key));
}

const AUTH_ERROR_KEYS = ['error', 'error_description', 'error_code'] as const;

export function hasAuthErrorParams(search = '', hash = ''): boolean {
  const query = new URLSearchParams(search || '');
  const fragment = new URLSearchParams((hash || '').replace(/^#/, ''));
  return AUTH_ERROR_KEYS.some((key) => query.has(key) || fragment.has(key));
}

export function readAuthUrlError(search = '', hash = ''): string {
  const query = new URLSearchParams(search || '');
  const fragment = new URLSearchParams((hash || '').replace(/^#/, ''));
  const description = (fragment.get('error_description') || query.get('error_description') || '').trim();
  if (description) return description;
  const code = (fragment.get('error') || query.get('error') || fragment.get('error_code') || query.get('error_code') || '').trim();
  if (!code) return '';
  if (code === 'access_denied') return 'Google sign-in was cancelled. You can try again or use email.';
  return code;
}

export function appendAuthErrorParams(targetPath: string, search = '', hash = ''): string {
  const query = new URLSearchParams(search || '');
  const fragment = new URLSearchParams((hash || '').replace(/^#/, ''));
  const url = new URL(targetPath.startsWith('/') && !targetPath.startsWith('//') ? targetPath : '/', 'https://nexora.invalid');
  for (const key of AUTH_ERROR_KEYS) {
    const value = fragment.get(key) || query.get(key);
    if (value && !url.searchParams.has(key)) url.searchParams.set(key, value);
  }
  return url.pathname + url.search + url.hash;
}

const TRANSIENT_CUSTOMER_AUTH_KEYS = [
  'auth',
  'code',
  'access_token',
  'refresh_token',
  'type',
  'error',
  'error_description',
  'error_code',
  'passwordUpdated',
  'recovery',
  'state',
  'sb',
  'ref',
];

export function cleanCustomerAppReturnPath(search = '', customerRef?: string | null): string {
  const params = new URLSearchParams(search || '');
  for (const key of TRANSIENT_CUSTOMER_AUTH_KEYS) params.delete(key);
  params.set('app', '1');
  if (customerRef !== undefined) {
    const normalized = (customerRef || '').trim().toUpperCase();
    if (normalized) params.set('customer_ref', normalized);
    else params.delete('customer_ref');
  }
  return `/?${params.toString()}`;
}

export type OAuthFlowKind = 'owner' | 'customer' | 'app' | 'invite';
export interface OAuthIntent {
  path: string;
  flow: OAuthFlowKind;
  savedAt: number;
}

const OAUTH_INTENT_KEY = 'studioflow_oauth_intent';
const OAUTH_INTENT_TTL_MS = 15 * 60 * 1000;

export function saveOAuthIntent(intent: { path: string; flow: OAuthFlowKind }): void {
  if (!intent.path.startsWith('/') || intent.path.startsWith('//')) return;
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(OAUTH_INTENT_KEY, JSON.stringify({ ...intent, savedAt: Date.now() }));
    }
  } catch {
    // Storage may be unavailable in privacy-restricted environments.
  }
}

export function readOAuthIntent(): OAuthIntent | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(OAUTH_INTENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OAuthIntent> | null;
    if (
      !parsed ||
      typeof parsed.path !== 'string' ||
      !parsed.path.startsWith('/') ||
      parsed.path.startsWith('//') ||
      typeof parsed.savedAt !== 'number' ||
      Date.now() - parsed.savedAt > OAUTH_INTENT_TTL_MS
    ) {
      sessionStorage.removeItem(OAUTH_INTENT_KEY);
      return null;
    }
    const flow = parsed.flow === 'customer' || parsed.flow === 'app' || parsed.flow === 'invite' ? parsed.flow : 'owner';
    return { path: parsed.path, flow, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

export function clearOAuthIntent(): void {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(OAUTH_INTENT_KEY);
  } catch {
    // ignore
  }
}

export interface PendingBookingFlowDraft {
  salonSlug: string;
  ids: string[];
  stylist: string;
  date: string;
  slot: any;
  branchId?: string;
  notes?: string;
  demo?: boolean;
  savedAt: number;
}

const PENDING_BOOKING_FLOW_KEY = 'nexora_pending_booking_flow';
const PENDING_BOOKING_TTL_MS = 15 * 60 * 1000;

export function savePendingBookingFlow(draft: Omit<PendingBookingFlowDraft, 'savedAt'>): void {
  if (!draft.salonSlug) return;
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(PENDING_BOOKING_FLOW_KEY, JSON.stringify({ ...draft, savedAt: Date.now() }));
    }
  } catch {
    // ignore
  }
}

export function consumePendingBookingFlow(demo = false): PendingBookingFlowDraft | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(PENDING_BOOKING_FLOW_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_BOOKING_FLOW_KEY);
    const parsed = JSON.parse(raw) as Partial<PendingBookingFlowDraft> | null;
    if (
      !parsed ||
      typeof parsed.salonSlug !== 'string' ||
      !parsed.salonSlug ||
      Boolean(parsed.demo) !== Boolean(demo) ||
      typeof parsed.savedAt !== 'number' ||
      Date.now() - parsed.savedAt > PENDING_BOOKING_TTL_MS
    ) {
      return null;
    }
    return {
      salonSlug: parsed.salonSlug,
      ids: Array.isArray(parsed.ids) ? parsed.ids.filter((x): x is string => typeof x === 'string') : [],
      stylist: typeof parsed.stylist === 'string' && parsed.stylist ? parsed.stylist : 'any',
      date: typeof parsed.date === 'string' ? parsed.date : '',
      slot: parsed.slot && typeof parsed.slot === 'object' ? parsed.slot : null,
      branchId: typeof parsed.branchId === 'string' ? parsed.branchId : '',
      notes: typeof parsed.notes === 'string' ? parsed.notes : '',
      demo: Boolean(parsed.demo),
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
}

export function clearPendingBookingFlow(): void {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(PENDING_BOOKING_FLOW_KEY);
  } catch {
    // ignore
  }
}
