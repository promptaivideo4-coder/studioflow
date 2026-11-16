import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, RefreshCw, ShieldCheck, Unplug, Wifi, WifiOff } from 'lucide-react';
import { supabase } from '../lib/supabase';

type WhatsAppStatus = {
  ok?: boolean;
  configured?: boolean;
  missingConfiguration?: string[];
  appId?: string | null;
  configurationId?: string | null;
  graphApiVersion?: string | null;
  salon?: { name?: string; slug?: string };
  connection?: {
    connected?: boolean;
    phoneNumber?: string;
    businessName?: string;
    status?: string;
    webhookSubscribed?: boolean;
    connectedAt?: string;
    tokenExpiresAt?: string | null;
    mode?: string;
    isOnBusinessApp?: boolean;
  } | null;
  metrics?: {
    enquiries?: number;
    messagesSent?: number;
    bookings?: number;
    confirmedBookings?: number;
    pendingBookings?: number;
    cancelledBookings?: number;
    paymentLinksSent?: number;
    paymentsPaid?: number;
    paymentsPending?: number;
    paymentsFailed?: number;
    advanceCollectedINR?: number;
  };
};

type EmbeddedSignupInfo = {
  wabaId: string;
  phoneNumberId: string;
  businessId: string;
};

type FacebookLoginResponse = {
  authResponse?: { code?: string };
  status?: string;
  code?: string;
};

type FacebookSdk = {
  init(options: { appId: string; cookie: boolean; xfbml: boolean; version: string }): void;
  login(
    callback: (response: FacebookLoginResponse) => void,
    options: {
      config_id: string;
      response_type: 'code';
      override_default_response_type: true;
      extras: Record<string, unknown>;
    },
  ): void;
};

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

let facebookSdkPromise: Promise<FacebookSdk> | null = null;

function loadFacebookSdk(appId: string, version: string): Promise<FacebookSdk> {
  if (window.FB) {
    window.FB.init({ appId, cookie: true, xfbml: false, version });
    return Promise.resolve(window.FB);
  }
  if (facebookSdkPromise) return facebookSdkPromise;

  facebookSdkPromise = new Promise((resolve, reject) => {
    const existing = document.getElementById('facebook-jssdk') as HTMLScriptElement | null;
    const script = existing || document.createElement('script');
    let settled = false;

    const fail = () => {
      if (settled) return;
      settled = true;
      facebookSdkPromise = null;
      reject(new Error('Meta login could not load. Please allow the Facebook login popup and try again.'));
    };

    window.fbAsyncInit = () => {
      if (!window.FB) return fail();
      window.FB.init({ appId, cookie: true, xfbml: false, version });
      if (!settled) {
        settled = true;
        resolve(window.FB);
      }
    };

    script.id = 'facebook-jssdk';
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.onerror = fail;
    if (!existing) document.head.appendChild(script);

    window.setTimeout(() => {
      if (!window.FB) fail();
    }, 20000);
  });

  return facebookSdkPromise;
}

function parseSignupMessage(event: MessageEvent): EmbeddedSignupInfo | null {
  const origin = (() => {
    try { return new URL(event.origin).hostname.toLowerCase(); }
    catch { return ''; }
  })();
  if (origin !== 'facebook.com' && !origin.endsWith('.facebook.com')) return null;

  let message: Record<string, unknown> | null = null;
  if (typeof event.data === 'string') {
    try { message = JSON.parse(event.data) as Record<string, unknown>; }
    catch { return null; }
  } else if (event.data && typeof event.data === 'object') {
    message = event.data as Record<string, unknown>;
  }
  if (!message || message.type !== 'WA_EMBEDDED_SIGNUP') return null;

  const eventName = String(message.event || '').toUpperCase();
  if (eventName !== 'FINISH') return null;

  const data = message.data && typeof message.data === 'object'
    ? message.data as Record<string, unknown>
    : message;
  const wabaId = String(data.waba_id || data.wabaId || '').trim();
  const phoneNumberId = String(data.phone_number_id || data.phoneNumberId || '').trim();
  const businessId = String(data.business_id || data.businessId || '').trim();
  if (!/^\d{5,40}$/.test(wabaId) || !/^\d{5,40}$/.test(phoneNumberId)) return null;
  return { wabaId, phoneNumberId, businessId };
}

function runEmbeddedSignup(fb: FacebookSdk, configId: string): Promise<{ code: string; signup: EmbeddedSignupInfo }> {
  return new Promise((resolve, reject) => {
    let code = '';
    let signup: EmbeddedSignupInfo | null = null;
    let done = false;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timeout);
    };
    const fail = (error: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    };
    const finishIfReady = () => {
      if (done || !code || !signup) return;
      done = true;
      cleanup();
      resolve({ code, signup });
    };
    const onMessage = (event: MessageEvent) => {
      const info = parseSignupMessage(event);
      if (!info) return;
      signup = info;
      finishIfReady();
    };
    const timeout = window.setTimeout(() => {
      fail(new Error('Meta signup did not finish. Please close the Meta window and try again.'));
    }, 5 * 60 * 1000);

    window.addEventListener('message', onMessage);
    try {
      fb.login((result) => {
        const returnedCode = String(result.authResponse?.code || result.code || '').trim();
        if (returnedCode) {
          code = returnedCode;
          finishIfReady();
          return;
        }
        fail(new Error('Meta login was cancelled or did not return an authorization code.'));
      }, {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: {},
      });
    } catch {
      fail(new Error('Meta signup could not be opened. Please check popup settings and try again.'));
    }
  });
}

function formatDate(value?: string | null) {
  if (!value) return 'Not available';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleString('en-IN');
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-[11px] font-semibold text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-extrabold text-slate-900 tabular-nums">{value}</div>
    </div>
  );
}

export function NexoraWhatsAppIntegration() {
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const activeRef = useRef(true);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError('');
    const { data, error: invokeError } = await supabase.functions.invoke('nexora-whatsapp-connect', {
      body: { action: 'status' },
    });
    if (!activeRef.current) return;
    if (invokeError || !data?.ok) {
      setStatus(null);
      setError(data?.error || invokeError?.message || 'WhatsApp status could not be loaded.');
    } else {
      setStatus(data as WhatsAppStatus);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    activeRef.current = true;
    void loadStatus();
    return () => { activeRef.current = false; };
  }, [loadStatus]);

  const connect = async () => {
    setWorking(true);
    setError('');
    setNotice('');
    try {
      const { data: started, error: startError } = await supabase.functions.invoke('nexora-whatsapp-connect', {
        body: { action: 'start' },
      });
      if (startError || !started?.ok) {
        const missing = Array.isArray(started?.missingConfiguration) ? started.missingConfiguration.join(', ') : '';
        throw new Error(started?.error || (missing ? `NEXORA Meta setup needs: ${missing}` : startError?.message) || 'Could not start Meta signup.');
      }

      const appId = String(started.appId || '');
      const configId = String(started.configurationId || '');
      const graphVersion = String(started.graphApiVersion || '');
      const stateToken = String(started.stateToken || '');
      if (!appId || !configId || !graphVersion || stateToken.length < 32) {
        throw new Error('Meta Embedded Signup is not fully configured for NEXORA.');
      }

      const facebook = await loadFacebookSdk(appId, graphVersion);
      const result = await runEmbeddedSignup(facebook, configId);
      const { data: completed, error: completeError } = await supabase.functions.invoke('nexora-whatsapp-connect', {
        body: {
          action: 'complete',
          stateToken,
          code: result.code,
          wabaId: result.signup.wabaId,
          phoneNumberId: result.signup.phoneNumberId,
          businessId: result.signup.businessId,
        },
      });
      if (completeError || !completed?.ok) {
        throw new Error(completed?.error || completeError?.message || 'Meta connected, but NEXORA could not finish saving the number.');
      }
      setNotice(`WhatsApp ${completed.connection?.phoneNumber || ''} connected successfully.`);
      await loadStatus();
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'WhatsApp connection failed.');
    } finally {
      setWorking(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect this salon WhatsApp number? New WhatsApp bookings will stop.')) return;
    setWorking(true);
    setError('');
    setNotice('');
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('nexora-whatsapp-connect', {
        body: { action: 'disconnect' },
      });
      if (invokeError || !data?.ok) throw new Error(data?.error || invokeError?.message || 'Could not disconnect WhatsApp.');
      setNotice('Salon WhatsApp disconnected.');
      await loadStatus();
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : 'WhatsApp disconnect failed.');
    } finally {
      setWorking(false);
    }
  };

  const connection = status?.connection;
  const metrics = status?.metrics;

  return (
    <section className="space-y-5">
      <div className="rounded-2xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-white p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-600 text-white">
              <MessageCircle size={25} />
            </span>
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-800">Salon-owned WhatsApp</p>
              <h2 className="mt-1 text-xl font-extrabold text-slate-950">WhatsApp bookings & payments</h2>
              <p className="mt-1 max-w-2xl text-sm text-slate-600">
                Connect your salon's own WhatsApp Business number. Customers will see messages from this salon number, not a shared NEXORA number.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadStatus()}
            disabled={loading || working}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        <div className="mt-5 rounded-xl border border-white bg-white/85 p-4">
          {loading ? (
            <p className="text-sm text-slate-500">Checking WhatsApp connection…</p>
          ) : connection?.connected ? (
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 text-emerald-600"><Wifi size={21} /></span>
                <div>
                  <div className="font-bold text-slate-900">{connection.businessName || status?.salon?.name || 'Connected salon'}</div>
                  <div className="mt-0.5 text-sm font-semibold text-slate-700">{connection.phoneNumber}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {connection.webhookSubscribed ? 'Messages are connected' : 'Webhook subscription needs attention'} · Connected {formatDate(connection.connectedAt)}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-3 py-1 text-[11px] font-bold text-emerald-800">
                  <ShieldCheck size={13} /> {connection.webhookSubscribed ? 'Connected' : 'Check webhook'}
                </span>
                <button
                  type="button"
                  onClick={() => void disconnect()}
                  disabled={working}
                  className="inline-flex items-center gap-2 rounded-xl border border-rose-200 px-3 py-2 text-xs font-bold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                >
                  <Unplug size={14} /> Disconnect
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 text-slate-400"><WifiOff size={21} /></span>
                <div>
                  <div className="font-bold text-slate-900">No salon WhatsApp connected</div>
                  <p className="mt-1 max-w-xl text-xs text-slate-500">Connect a WhatsApp Business number owned by this salon. One number cannot be shared by two NEXORA salon accounts.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void connect()}
                disabled={working || loading || status?.configured !== true}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-3 text-sm font-bold text-white shadow-sm hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {working ? 'Connecting…' : 'Connect my WhatsApp'}
              </button>
            </div>
          )}
        </div>

        {status?.configured === false && !connection?.connected && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <div className="text-sm font-bold text-amber-900">NEXORA Meta setup is not ready yet</div>
            <p className="mt-1 text-xs text-amber-800">The platform administrator must complete these server settings before salon owners can connect a number:</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(status.missingConfiguration || []).map((name) => (
                <span key={name} className="rounded-full bg-white px-2.5 py-1 text-[10px] font-mono font-bold text-amber-900">{name}</span>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 rounded-xl bg-slate-900 p-4 text-xs leading-relaxed text-slate-200">
          <strong className="text-white">How it works:</strong> Customer selects a service, branch, date and time on WhatsApp. The system checks live calendar availability, asks for final YES confirmation, creates a booking request, then sends the salon's secure 25% advance payment link. The booking confirms only after the payment provider verifies payment.
        </div>
      </div>

      {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}
      {notice && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">{notice}</div>}

      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="font-extrabold text-slate-900">WhatsApp activity</h3>
            <p className="text-xs text-slate-500">Numbers are read from this salon's message log, bookings and payment records.</p>
          </div>
          <span className="text-[10px] font-semibold text-slate-400">This salon only</span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          <Metric label="Enquiries" value={String(metrics?.enquiries ?? 0)} />
          <Metric label="Messages sent" value={String(metrics?.messagesSent ?? 0)} />
          <Metric label="WhatsApp bookings" value={String(metrics?.bookings ?? 0)} />
          <Metric label="Confirmed" value={String(metrics?.confirmedBookings ?? 0)} />
          <Metric label="Awaiting payment" value={String(metrics?.pendingBookings ?? 0)} />
          <Metric label="Payment links" value={String(metrics?.paymentLinksSent ?? 0)} />
          <Metric label="Payments received" value={String(metrics?.paymentsPaid ?? 0)} />
          <Metric label="Advance collected" value={`₹${Number(metrics?.advanceCollectedINR ?? 0).toLocaleString('en-IN')}`} />
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600">
        <strong className="text-slate-800">Customer privacy:</strong> WhatsApp opt-out words like STOP are respected. Messages sent outside WhatsApp's 24-hour customer-service window require approved message templates and customer opt-in.
      </div>
    </section>
  );
}
