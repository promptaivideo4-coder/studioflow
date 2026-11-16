import { createClient } from 'npm:@supabase/supabase-js@2.117.3';

type RecordValue = Record<string, unknown>;

const allowedOrigins = new Set([
  'https://nexorasalon.online',
  'https://www.nexorasalon.online',
  'http://localhost:5173',
]);

function corsFor(request: Request) {
  const origin = request.headers.get('origin') || '';
  if (!allowedOrigins.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsFor(request),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function env(name: string) {
  return (Deno.env.get(name) || '').trim();
}

function base64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Url(bytes: Uint8Array) {
  return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

function encryptionKey() {
  const raw = env('META_TOKEN_ENCRYPTION_KEY');
  if (!raw) throw new Error('META_TOKEN_ENCRYPTION_KEY is not configured.');
  let bytes: Uint8Array;
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    bytes = new Uint8Array(raw.match(/.{2}/g)!.map((part) => parseInt(part, 16)));
  } else {
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  if (bytes.length !== 32) throw new Error('META_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  return bytes;
}

async function encryptToken(token: string) {
  const keyBytes = encryptionKey();
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token));
  return { ciphertext: base64(new Uint8Array(ciphertext)), iv: base64(iv) };
}

function graphUrl(version: string, path: string) {
  return `https://graph.facebook.com/${version}/${path.replace(/^\//, '')}`;
}

async function graphRequest(version: string, path: string, token: string, init: RequestInit = {}) {
  const response = await fetch(graphUrl(version, path), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json().catch(() => ({})) as RecordValue;
  if (!response.ok) {
    const error = body.error as RecordValue | undefined;
    const message = typeof error?.message === 'string' ? error.message : 'Meta rejected the WhatsApp connection request.';
    throw new Error(message);
  }
  return body;
}

function metaConfiguration() {
  const appId = env('META_APP_ID');
  const configId = env('META_EMBEDDED_SIGNUP_CONFIG_ID');
  const graphVersion = env('META_GRAPH_API_VERSION');
  const required: Array<[string, string]> = [
    ['META_APP_ID', appId],
    ['META_APP_SECRET', env('META_APP_SECRET')],
    ['META_EMBEDDED_SIGNUP_CONFIG_ID', configId],
    ['META_GRAPH_API_VERSION', graphVersion],
    ['META_WEBHOOK_VERIFY_TOKEN', env('META_WEBHOOK_VERIFY_TOKEN')],
    ['META_TOKEN_ENCRYPTION_KEY', env('META_TOKEN_ENCRYPTION_KEY')],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (graphVersion && !/^v\\d+\\.\\d+$/.test(graphVersion)) missing.push('META_GRAPH_API_VERSION (format: v27.0)');
  return { appId, configId, graphVersion, missing };
}

async function getAuthenticatedOwner(request: Request, service: any) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('Sign in to your salon owner account first.');
  const { data, error } = await service.auth.getUser(token);
  if (error || !data.user) throw new Error('Your salon session expired. Sign in again.');
  const ownerId = data.user.id;
  const { data: account, error: accountError } = await service
    .from('studioflow_accounts')
    .select('user_id')
    .eq('user_id', ownerId)
    .maybeSingle();
  if (accountError || !account) throw new Error('This account does not have a NEXORA salon workspace.');
  const { data: website, error: websiteError } = await service
    .from('studioflow_websites')
    .select('slug,content')
    .eq('owner_id', ownerId)
    .maybeSingle();
  if (websiteError || !website) throw new Error('Publish your salon website before connecting WhatsApp.');
  return { user: data.user, ownerId, website };
}

async function dashboardMetrics(service: any, ownerId: string) {
  const { data: bookings, error: bookingsError } = await service
    .from('studioflow_bookings')
    .select('id,status,payload')
    .eq('owner_id', ownerId)
    .eq('booking_source', 'whatsapp');
  if (bookingsError) throw new Error('WhatsApp booking metrics could not be loaded.');
  const rows = bookings || [];
  const ids = rows.map((row) => row.id);
  let paymentRows: RecordValue[] = [];
  if (ids.length) {
    const { data, error } = await service
      .from('studioflow_payment_orders')
      .select('booking_id,amount_paise,status,payment_link_status')
      .in('booking_id', ids);
    if (error) throw new Error('WhatsApp payment metrics could not be loaded.');
    paymentRows = (data || []) as RecordValue[];
  }
  const [inbound, outbound] = await Promise.all([
    service.from('salon_whatsapp_message_log').select('id', { count: 'exact', head: true }).eq('owner_id', ownerId).eq('direction', 'inbound'),
    service.from('salon_whatsapp_message_log').select('id', { count: 'exact', head: true }).eq('owner_id', ownerId).eq('direction', 'outbound'),
  ]);
  return {
    enquiries: inbound.count || 0,
    messagesSent: outbound.count || 0,
    bookings: rows.length,
    confirmedBookings: rows.filter((row) => row.status === 'confirmed').length,
    pendingBookings: rows.filter((row) => row.status === 'pending').length,
    cancelledBookings: rows.filter((row) => row.status === 'cancelled').length,
    paymentLinksSent: paymentRows.filter((row) => Boolean(row.payment_link_status)).length,
    paymentsPaid: paymentRows.filter((row) => row.status === 'captured').length,
    paymentsPending: paymentRows.filter((row) => row.status === 'created').length,
    paymentsFailed: paymentRows.filter((row) => ['expired', 'cancelled', 'failed'].includes(String(row.payment_link_status || '').toLowerCase()) || row.status === 'refund_required').length,
    advanceCollectedINR: Math.round(paymentRows.filter((row) => row.status === 'captured').reduce((sum, row) => sum + Number(row.amount_paise || 0), 0)) / 100,
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsFor(request) });
  }
  if (request.method !== 'POST') return json(request, { error: 'POST required' }, 405);
  const origin = request.headers.get('origin') || '';
  if (!allowedOrigins.has(origin)) return json(request, { error: 'Origin not allowed' }, 403);

  try {
    const supabaseUrl = env('SUPABASE_URL');
    const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) return json(request, { error: 'WhatsApp service is missing server credentials.' }, 503);
    const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const raw = await request.text();
    if (raw.length > 16000) return json(request, { error: 'Request too large.' }, 413);
    let body: RecordValue;
    try { body = JSON.parse(raw || '{}') as RecordValue; }
    catch { return json(request, { error: 'Invalid JSON request.' }, 400); }
    const action = typeof body.action === 'string' ? body.action : '';
    const { ownerId, user, website } = await getAuthenticatedOwner(request, service);

    if (action === 'status') {
      const [connectionResult, metrics] = await Promise.all([
        service.from('salon_whatsapp_connections')
          .select('id,phone_number_id,waba_id,display_phone_number,verified_name,connection_status,webhook_subscribed,connected_at,token_expires_at,connection_mode,is_on_biz_app')
          .eq('owner_id', ownerId)
          .maybeSingle(),
        dashboardMetrics(service, ownerId),
      ]);
      if (connectionResult.error) throw new Error('WhatsApp connection status could not be loaded.');
      const config = metaConfiguration();
      const connection = connectionResult.data;
      return json(request, {
        ok: true,
        salon: {
          name: String((website.content as RecordValue)?.profile && ((website.content as RecordValue).profile as RecordValue).businessName || 'Your salon'),
          slug: website.slug,
        },
        configured: config.missing.length === 0,
        missingConfiguration: config.missing,
        appId: config.appId || null,
        configurationId: config.configId || null,
        graphApiVersion: config.graphVersion || null,
        connection: connection ? {
          connected: connection.connection_status === 'connected',
          phoneNumber: connection.display_phone_number,
          businessName: connection.verified_name,
          status: connection.connection_status,
          webhookSubscribed: connection.webhook_subscribed,
          connectedAt: connection.connected_at,
          tokenExpiresAt: connection.token_expires_at,
          mode: connection.connection_mode || 'standard',
          isOnBusinessApp: connection.is_on_biz_app === true,
        } : null,
        metrics,
      });
    }

    if (action === 'start') {
      const config = metaConfiguration();
      if (config.missing.length) {
        return json(request, {
          ok: false,
          error: 'NEXORA Meta WhatsApp setup is not complete yet.',
          missingConfiguration: config.missing,
        }, 503);
      }
      const random = crypto.getRandomValues(new Uint8Array(32));
      const stateToken = base64Url(random);
      const stateHash = await sha256(stateToken);
      const { error } = await service.from('salon_whatsapp_oauth_states').insert({
        salon_id: null,
        owner_id: ownerId,
        initiated_by: user.id,
        state_hash: stateHash,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      if (error) throw new Error('Could not safely start the Meta connection. Please try again.');
      return json(request, {
        ok: true,
        stateToken,
        appId: config.appId,
        configurationId: config.configId,
        graphApiVersion: config.graphVersion,
        expiresInSeconds: 600,
      });
    }

    if (action === 'complete') {
      const config = metaConfiguration();
      if (config.missing.length) {
        return json(request, { error: 'NEXORA Meta WhatsApp setup is incomplete.', missingConfiguration: config.missing }, 503);
      }
      const stateToken = typeof body.stateToken === 'string' ? body.stateToken : '';
      const code = typeof body.code === 'string' ? body.code : '';
      const wabaId = typeof body.wabaId === 'string' ? body.wabaId : '';
      const phoneNumberId = typeof body.phoneNumberId === 'string' ? body.phoneNumberId : '';
      const businessId = typeof body.businessId === 'string' ? body.businessId : '';
      if (stateToken.length < 32 || code.length < 20 || !/^\d{5,40}$/.test(wabaId) || !/^\d{5,40}$/.test(phoneNumberId)) {
        return json(request, { error: 'Meta returned incomplete WhatsApp account details. Please restart connection.' }, 400);
      }

      const stateHash = await sha256(stateToken);
      const { data: consumed, error: stateError } = await service
        .from('salon_whatsapp_oauth_states')
        .update({ consumed_at: new Date().toISOString() })
        .eq('state_hash', stateHash)
        .eq('owner_id', ownerId)
        .eq('initiated_by', user.id)
        .is('consumed_at', null)
        .gt('expires_at', new Date().toISOString())
        .select('id')
        .maybeSingle();
      if (stateError || !consumed) return json(request, { error: 'This Meta connection request expired or was already used. Start again.' }, 409);

      const codeUrl = new URL(graphUrl(config.graphVersion, 'oauth/access_token'));
      codeUrl.searchParams.set('client_id', env('META_APP_ID'));
      codeUrl.searchParams.set('client_secret', env('META_APP_SECRET'));
      codeUrl.searchParams.set('code', code);
      const codeResponse = await fetch(codeUrl, { signal: AbortSignal.timeout(20000) });
      const codeBody = await codeResponse.json().catch(() => ({})) as RecordValue;
      if (!codeResponse.ok || typeof codeBody.access_token !== 'string') {
        throw new Error('Meta could not exchange the signup code. Check the app settings and try again.');
      }

      let accessToken = String(codeBody.access_token);
      let expiresIn = Number(codeBody.expires_in || 3600);
      const longLivedUrl = new URL(graphUrl(config.graphVersion, 'oauth/access_token'));
      longLivedUrl.searchParams.set('grant_type', 'fb_exchange_token');
      longLivedUrl.searchParams.set('client_id', env('META_APP_ID'));
      longLivedUrl.searchParams.set('client_secret', env('META_APP_SECRET'));
      longLivedUrl.searchParams.set('fb_exchange_token', accessToken);
      const longLivedResponse = await fetch(longLivedUrl, { signal: AbortSignal.timeout(20000) });
      const longLivedBody = await longLivedResponse.json().catch(() => ({})) as RecordValue;
      if (longLivedResponse.ok && typeof longLivedBody.access_token === 'string') {
        accessToken = String(longLivedBody.access_token);
        expiresIn = Number(longLivedBody.expires_in || expiresIn);
      }

      const phoneList = await graphRequest(config.graphVersion, `${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`, accessToken);
      const phoneRows = Array.isArray(phoneList.data) ? phoneList.data as RecordValue[] : [];
      const phone = phoneRows.find((row) => String(row.id) === phoneNumberId);
      if (!phone) throw new Error('The selected WhatsApp phone number does not belong to the WABA shared with this NEXORA salon.');

      await graphRequest(config.graphVersion, `${wabaId}/subscribed_apps`, accessToken, { method: 'POST' });

      const encrypted = await encryptToken(accessToken);
      const expiry = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
      const metadata = {
        connectedVia: 'meta_embedded_signup_v4',
        qualityRating: phone.quality_rating || null,
        lastVerifiedAt: new Date().toISOString(),
      };
      const { data: saved, error: saveError } = await service
        .from('salon_whatsapp_connections')
        .upsert({
          salon_id: null,
          owner_id: ownerId,
          waba_id: wabaId,
          phone_number_id: phoneNumberId,
          business_id: businessId || null,
          display_phone_number: String(phone.display_phone_number || ''),
          verified_name: String(phone.verified_name || ''),
          connection_status: 'connected',
          access_token_ciphertext: encrypted.ciphertext,
          access_token_iv: encrypted.iv,
          token_key_version: 1,
          token_expires_at: expiry,
          webhook_subscribed: true,
          connected_by: user.id,
          connected_at: new Date().toISOString(),
          disconnected_at: null,
          provider_metadata: metadata,
          platform_type: 'CLOUD_API',
          connection_mode: 'standard',
        }, { onConflict: 'owner_id' })
        .select('id,display_phone_number,verified_name,connection_status,webhook_subscribed,connected_at,token_expires_at')
        .single();
      if (saveError || !saved) {
        if (String(saveError?.code) === '23505') {
          throw new Error('This WhatsApp number is already connected to another NEXORA salon. Disconnect it there first.');
        }
        throw new Error('Meta connected, but NEXORA could not save the secure connection. Please try again.');
      }

      return json(request, {
        ok: true,
        connection: {
          connected: true,
          phoneNumber: saved.display_phone_number,
          businessName: saved.verified_name,
          status: saved.connection_status,
          webhookSubscribed: saved.webhook_subscribed,
          connectedAt: saved.connected_at,
          tokenExpiresAt: saved.token_expires_at,
        },
      });
    }

    if (action === 'disconnect') {
      const { error } = await service
        .from('salon_whatsapp_connections')
        .delete()
        .eq('owner_id', ownerId);
      if (error) throw new Error('Could not disconnect WhatsApp. Please try again.');
      return json(request, { ok: true, disconnected: true });
    }

    return json(request, { error: 'Unknown WhatsApp connection action.' }, 400);
  } catch (error) {
    return json(request, { error: error instanceof Error ? error.message : 'WhatsApp connection could not be completed.' }, 400);
  }
});
