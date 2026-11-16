import { createClient } from 'npm:@supabase/supabase-js@2.117.3';

type Row = Record<string, unknown>;
type Connection = {
  owner_id: string;
  phone_number_id: string;
  waba_id: string;
  access_token_ciphertext: string;
  access_token_iv: string;
  token_key_version: number;
  connection_status: string;
};

const corsOrigins = new Set([
  'https://nexorasalon.online',
  'https://www.nexorasalon.online',
  'http://localhost:5173',
]);

function cors(request: Request) {
  const origin = request.headers.get('origin') || '';
  return corsOrigins.has(origin) ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  } : {};
}

function response(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function env(name: string) {
  return (Deno.env.get(name) || '').trim();
}

function safeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function bytesFromBase64(value: string) {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function tokenKey() {
  const raw = env('META_TOKEN_ENCRYPTION_KEY');
  if (!raw) throw new Error('WhatsApp token encryption is not configured.');
  let bytes: Uint8Array;
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    bytes = new Uint8Array(raw.match(/.{2}/g)!.map((part) => parseInt(part, 16)));
  } else {
    bytes = bytesFromBase64(raw);
  }
  if (bytes.length !== 32) throw new Error('WhatsApp token encryption key must be 32 bytes.');
  return bytes;
}

async function decryptToken(connection: Connection) {
  if (connection.token_key_version !== 1) throw new Error('Unsupported WhatsApp token key version.');
  const key = await crypto.subtle.importKey('raw', tokenKey(), 'AES-GCM', false, ['decrypt']);
  const clear = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytesFromBase64(connection.access_token_iv) },
    key,
    bytesFromBase64(connection.access_token_ciphertext),
  );
  return new TextDecoder().decode(clear);
}

async function hmacHex(secret: string, value: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function signatureMatches(raw: string, signature: string) {
  const secret = env('META_APP_SECRET');
  if (!secret || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  return safeEqual('sha256=' + await hmacHex(secret, raw), signature.toLowerCase());
}

function graphUrl(path: string) {
  const version = env('META_GRAPH_API_VERSION');
  if (!/^v\d+\.\d+$/.test(version)) throw new Error('META_GRAPH_API_VERSION is not configured correctly.');
  return `https://graph.facebook.com/${version}/${path.replace(/^\//, '')}`;
}

async function graphSend(connection: Connection, to: string, payload: Row) {
  const token = await decryptToken(connection);
  const result = await fetch(graphUrl(`${connection.phone_number_id}/messages`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await result.json().catch(() => ({})) as Row;
  if (!result.ok) {
    const error = data.error as Row | undefined;
    throw Object.assign(new Error(typeof error?.message === 'string' ? error.message : 'WhatsApp message could not be sent.'), {
      code: String(error?.code || 'META_SEND_FAILED'),
    });
  }
  const messages = Array.isArray(data.messages) ? data.messages as Row[] : [];
  return String(messages[0]?.id || '');
}

async function logOutbound(
  service: ReturnType<typeof createClient>,
  connection: Connection,
  to: string,
  kind: string,
  body: string,
  options: { bookingId?: string | null; paymentBookingId?: string | null; templateName?: string | null; metadata?: Row } = {},
) {
  const { data: row, error: insertError } = await service
    .from('salon_whatsapp_message_log')
    .insert({
      owner_id: connection.owner_id,
      salon_id: null,
      booking_id: options.bookingId || null,
      studioflow_payment_booking_id: options.paymentBookingId || null,
      direction: 'outbound',
      recipient_wa_id: to,
      message_kind: kind,
      delivery_status: 'queued',
      template_name: options.templateName || null,
      metadata: { body, ...(options.metadata || {}) },
    })
    .select('id')
    .single();
  if (insertError || !row) throw new Error('Could not record the WhatsApp message before sending.');
  try {
    const messageId = await graphSend(connection, to, { type: 'text', text: { preview_url: false, body } });
    await service.from('salon_whatsapp_message_log')
      .update({ provider_message_id: messageId || null, delivery_status: 'sent', updated_at: new Date().toISOString() })
      .eq('id', row.id);
    return messageId;
  } catch (error) {
    const code = typeof (error as Row)?.code === 'string' ? String((error as Row).code).slice(0, 80) : 'META_SEND_FAILED';
    await service.from('salon_whatsapp_message_log')
      .update({ delivery_status: 'failed', error_code: code, updated_at: new Date().toISOString() })
      .eq('id', row.id);
    throw error;
  }
}

async function logTemplate(
  service: ReturnType<typeof createClient>,
  connection: Connection,
  to: string,
  templateName: string,
  parameters: string[],
  bookingId: string,
) {
  const { data: row, error: insertError } = await service
    .from('salon_whatsapp_message_log')
    .insert({
      owner_id: connection.owner_id,
      salon_id: null,
      booking_id: bookingId,
      studioflow_payment_booking_id: bookingId,
      direction: 'outbound',
      recipient_wa_id: to,
      message_kind: 'payment_success',
      delivery_status: 'queued',
      template_name: templateName,
      metadata: { templateParameters: parameters },
    })
    .select('id')
    .single();
  if (insertError || !row) throw new Error('Could not record WhatsApp payment confirmation.');
  try {
    const token = await decryptToken(connection);
    const result = await fetch(graphUrl(`${connection.phone_number_id}/messages`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: env('META_WHATSAPP_TEMPLATE_LANGUAGE') || 'en_IN' },
          components: [{
            type: 'body',
            parameters: parameters.map((text) => ({ type: 'text', text })),
          }],
        },
      }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await result.json().catch(() => ({})) as Row;
    if (!result.ok) {
      const apiError = data.error as Row | undefined;
      throw Object.assign(new Error(typeof apiError?.message === 'string' ? apiError.message : 'WhatsApp template message failed.'), {
        code: String(apiError?.code || 'META_TEMPLATE_FAILED'),
      });
    }
    const messages = Array.isArray(data.messages) ? data.messages as Row[] : [];
    const messageId = String(messages[0]?.id || '');
    await service.from('salon_whatsapp_message_log')
      .update({ provider_message_id: messageId || null, delivery_status: 'sent', updated_at: new Date().toISOString() })
      .eq('id', row.id);
  } catch (error) {
    const code = typeof (error as Row)?.code === 'string' ? String((error as Row).code).slice(0, 80) : 'META_TEMPLATE_FAILED';
    await service.from('salon_whatsapp_message_log')
      .update({ delivery_status: 'failed', error_code: code, updated_at: new Date().toISOString() })
      .eq('id', row.id);
    throw error;
  }
}

async function getConnectionByPhone(service: ReturnType<typeof createClient>, phoneNumberId: string) {
  const { data, error } = await service
    .from('salon_whatsapp_connections')
    .select('owner_id,phone_number_id,waba_id,access_token_ciphertext,access_token_iv,token_key_version,connection_status')
    .eq('phone_number_id', phoneNumberId)
    .eq('connection_status', 'connected')
    .eq('webhook_subscribed', true)
    .maybeSingle();
  if (error || !data) return null;
  return data as Connection;
}

function cleanText(value: unknown, max = 400) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

function normalizePhone(waId: string) {
  return /^\d{8,15}$/.test(waId) ? '+' + waId : '';
}

function parseChoice(value: string, count: number) {
  const match = value.trim().match(/^([1-9]\d*)$/);
  if (!match) return -1;
  const position = Number(match[1]) - 1;
  return position >= 0 && position < count ? position : -1;
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00+05:30');
  if (!Number.isFinite(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === value
    && date.getTime() > Date.now()
    && date.getTime() <= Date.now() + 90 * 24 * 60 * 60 * 1000;
}

async function getSalon(service: ReturnType<typeof createClient>, ownerId: string) {
  const { data, error } = await service
    .from('studioflow_websites')
    .select('slug,content')
    .eq('owner_id', ownerId)
    .maybeSingle();
  if (error || !data) throw new Error('The salon website is not published.');
  return data as { slug: string; content: Row };
}

async function getCatalogue(service: ReturnType<typeof createClient>, ownerId: string) {
  const website = await getSalon(service, ownerId);
  const rawServices = Array.isArray(website.content.services) ? website.content.services as Row[] : [];
  const services = rawServices.filter((item) => item && cleanText(item.id, 120) && cleanText(item.name, 120))
    .map((item) => ({
      id: String(item.id),
      name: cleanText(item.name, 120),
      price: Number(item.price || 0),
      durationMinutes: Number(item.durationMinutes || 0),
    }))
    .filter((item) => Number.isFinite(item.price) && item.price >= 0 && Number.isInteger(item.durationMinutes) && item.durationMinutes > 0)
    .slice(0, 9);
  const { data: branches, error } = await service
    .from('branches')
    .select('id,name,city')
    .eq('site_id', ownerId)
    .eq('is_active', true)
    .order('created_at', { ascending: true });
  if (error) throw new Error('The salon locations could not be loaded.');
  const stylists = Array.isArray(website.content.stylists) ? website.content.stylists as Row[] : [];
  return {
    website,
    services,
    branches: (branches || []) as Array<{ id: string; name: string; city: string }>,
    stylists,
    businessName: cleanText((website.content.profile as Row | undefined)?.businessName, 120) || 'Your salon',
  };
}

async function saveConversation(service: ReturnType<typeof createClient>, ownerId: string, waId: string, patch: Row) {
  const { data: existing } = await service
    .from('salon_whatsapp_conversations')
    .select('id,flow_state,is_opted_out')
    .eq('owner_id', ownerId)
    .eq('customer_wa_id', waId)
    .maybeSingle();
  if (!existing) {
    const { data, error } = await service.from('salon_whatsapp_conversations').insert({
      owner_id: ownerId,
      salon_id: null,
      customer_wa_id: waId,
      conversation_status: 'active',
      flow_state: {},
      ...patch,
    }).select().single();
    if (error || !data) throw new Error('Could not start the WhatsApp booking conversation.');
    return data as Row;
  }
  const { data, error } = await service.from('salon_whatsapp_conversations')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', existing.id)
    .select()
    .single();
  if (error || !data) throw new Error('Could not save the WhatsApp booking conversation.');
  return data as Row;
}

async function getAvailableSlots(
  service: ReturnType<typeof createClient>,
  slug: string,
  serviceId: string,
  date: string,
  branchId: string | null,
) {
  const args = branchId ? {
    p_slug: slug,
    p_services: [serviceId],
    p_date: date,
    p_stylist: 'any',
    p_branch: branchId,
  } : {
    p_slug: slug,
    p_services: [serviceId],
    p_date: date,
    p_stylist: 'any',
  };
  const { data, error } = await service.rpc(branchId ? 'studioflow_branch_android_slots' : 'studioflow_android_slots', args);
  if (error || !Array.isArray(data)) throw new Error('Live availability is temporarily unavailable. Please try again.');
  return (data as Row[]).filter((slot) => slot && typeof slot.time === 'string' && typeof slot.stylistId === 'string'
    && (!('available' in slot) || slot.available === true));
}

function menuText(name: string, services: Array<{ id: string; name: string; price: number; durationMinutes: number }>) {
  const menu = services.slice(0, 9).map((service, index) =>
    `${index + 1}. ${service.name} — ₹${Math.round(service.price).toLocaleString('en-IN')} (${service.durationMinutes} min)`
  ).join('\n');
  return `Namaste! Welcome to ${name}.\n\nBooking ke liye service ka number reply karein:\n${menu}\n\nAap STOP bhej kar WhatsApp booking messages band kar sakte hain.`;
}

async function processCustomerMessage(
  service: ReturnType<typeof createClient>,
  connection: Connection,
  message: Row,
  contactName: string,
) {
  const waId = cleanText(message.from, 20);
  const messageId = cleanText(message.id, 180);
  if (!/^\d{8,15}$/.test(waId) || !messageId) return;
  const text = cleanText((message.text as Row | undefined)?.body, 1000);
  if (!text) {
    await logOutbound(service, connection, waId, 'conversation', 'Please reply with text to continue your booking. Type MENU to see services.');
    return;
  }

  const { data: event, error: eventError } = await service
    .from('salon_whatsapp_webhook_events')
    .insert({
      provider_event_id: messageId,
      phone_number_id: connection.phone_number_id,
      salon_id: null,
      owner_id: connection.owner_id,
      event_type: 'customer_message',
      payload: { from: waId, messageType: message.type || 'unknown', text },
      processing_status: 'processing',
    })
    .select('id')
    .maybeSingle();
  if (eventError && String(eventError.code) === '23505') {
    const { data: prior } = await service.from('salon_whatsapp_webhook_events')
      .select('id,processing_status')
      .eq('provider_event_id', messageId)
      .maybeSingle();
    if (prior?.processing_status === 'processed' || prior?.processing_status === 'ignored' || prior?.processing_status === 'processing') return;
    if (prior?.id) {
      await service.from('salon_whatsapp_webhook_events').update({ processing_status: 'processing', error_code: null }).eq('id', prior.id);
    } else return;
  } else if (eventError || !event) {
    return;
  }

  try {
    const lower = text.toLowerCase().trim();
    const { data: current } = await service
      .from('salon_whatsapp_conversations')
      .select('*')
      .eq('owner_id', connection.owner_id)
      .eq('customer_wa_id', waId)
      .maybeSingle();

    if (lower === 'stop' || lower === 'unsubscribe') {
      await saveConversation(service, connection.owner_id, waId, {
        is_opted_out: true,
        opted_out_at: new Date().toISOString(),
        conversation_status: 'closed',
        flow_state: { stage: 'opted_out' },
        last_message_id: messageId,
        last_inbound_at: new Date().toISOString(),
      });
      await logOutbound(service, connection, waId, 'conversation', 'Aapko WhatsApp booking messages se opt out kar diya gaya hai. Dobara shuru karne ke liye START bhejein.');
      await service.from('salon_whatsapp_message_log').insert({
        owner_id: connection.owner_id, salon_id: null, direction: 'inbound', recipient_wa_id: waId,
        message_kind: 'conversation', delivery_status: 'received', metadata: { text, messageId, optedOut: true },
      });
      return;
    }

    if (current?.is_opted_out && lower !== 'start') {
      await service.from('salon_whatsapp_webhook_events').update({ processing_status: 'ignored', processed_at: new Date().toISOString() }).eq('provider_event_id', messageId);
      return;
    }

    const catalogue = await getCatalogue(service, connection.owner_id);
    let flow = (current?.flow_state && typeof current.flow_state === 'object' ? current.flow_state : {}) as Row;
    let stage = typeof flow.stage === 'string' ? flow.stage : '';
    if (lower === 'start' || lower === 'menu' || lower === 'book' || lower === 'hi' || lower === 'hello' || !stage || stage === 'opted_out' || stage === 'booked') {
      flow = { stage: 'choose_service' };
      await saveConversation(service, connection.owner_id, waId, {
        customer_name: contactName || current?.customer_name || null,
        is_opted_out: false,
        opted_out_at: null,
        consent_recorded_at: current?.consent_recorded_at || new Date().toISOString(),
        conversation_status: 'active',
        flow_state: flow,
        last_inbound_at: new Date().toISOString(),
        last_message_id: messageId,
      });
      await logOutbound(service, connection, waId, 'conversation', menuText(catalogue.businessName, catalogue.services));
    } else if (stage === 'choose_service') {
      const position = parseChoice(text, catalogue.services.length);
      const serviceChoice = position >= 0 ? catalogue.services[position] : catalogue.services.find((item) => item.name.toLowerCase() === lower);
      if (!serviceChoice) {
        await logOutbound(service, connection, waId, 'conversation', `Service number sahi nahi hai.\n\n${menuText(catalogue.businessName, catalogue.services)}`);
      } else {
        flow = { ...flow, stage: 'choose_branch', serviceId: serviceChoice.id, serviceName: serviceChoice.name };
        if (catalogue.branches.length > 1) {
          const options = catalogue.branches.map((branch, index) => `${index + 1}. ${branch.name} — ${branch.city}`).join('\n');
          await saveConversation(service, connection.owner_id, waId, {
            customer_name: contactName || current?.customer_name || null,
            conversation_status: 'active',
            flow_state: flow,
            last_inbound_at: new Date().toISOString(),
            last_message_id: messageId,
          });
          await logOutbound(service, connection, waId, `Aapne ${serviceChoice.name} chuna hai. Branch number select karein:\n${options}`);
        } else {
          flow = { ...flow, stage: 'choose_date', branchId: catalogue.branches[0]?.id || null, branchName: catalogue.branches[0]?.name || null };
          await saveConversation(service, connection.owner_id, waId, {
            customer_name: contactName || current?.customer_name || null,
            conversation_status: 'active',
            flow_state: flow,
            last_inbound_at: new Date().toISOString(),
            last_message_id: messageId,
          });
          await logOutbound(service, connection, waId, `Aapne ${serviceChoice.name} chuna hai. Appointment date bhejein (YYYY-MM-DD).`);
        }
      }
    } else if (stage === 'choose_branch') {
      const position = parseChoice(text, catalogue.branches.length);
      if (position < 0) {
        const options = catalogue.branches.map((branch, index) => `${index + 1}. ${branch.name} — ${branch.city}`).join('\n');
        await logOutbound(service, connection, waId, `Branch number sahi nahi hai.\n${options}`);
      } else {
        const branch = catalogue.branches[position];
        flow = { ...flow, stage: 'choose_date', branchId: branch.id, branchName: branch.name };
        await saveConversation(service, connection.owner_id, waId, {
          customer_name: contactName || current?.customer_name || null,
          conversation_status: 'active',
          flow_state: flow,
          last_inbound_at: new Date().toISOString(),
          last_message_id: messageId,
        });
        await logOutbound(service, connection, waId, `Branch ${branch.name} select ho gayi. Appointment date bhejein (YYYY-MM-DD).`);
      }
    } else if (stage === 'choose_date') {
      if (!validDate(text)) {
        await logOutbound(service, connection, waId, 'Date YYYY-MM-DD format mein bhejein. Aaj se agle 90 din tak date choose kar sakte hain.');
      } else {
        const slots = await getAvailableSlots(service, catalogue.website.slug, String(flow.serviceId), text, typeof flow.branchId === 'string' ? flow.branchId : null);
        if (!slots.length) {
          await logOutbound(service, connection, waId, 'Is date par koi time available nahi hai. Dusri date bhejein (YYYY-MM-DD).');
        } else {
          const choices = slots.slice(0, 12).map((slot, index) => {
            const stylist = catalogue.stylists.find((person) => person.id === slot.stylistId);
            return {
              time: String(slot.time),
              stylistId: String(slot.stylistId),
              stylistName: cleanText(stylist?.name, 100) || 'Available specialist',
              branchId: String(slot.branchId || flow.branchId || ''),
              branchName: cleanText(slot.branchName || flow.branchName || '', 120),
            };
          });
          flow = { ...flow, stage: 'choose_time', date: text, availableSlots: choices };
          await saveConversation(service, connection.owner_id, waId, {
            customer_name: contactName || current?.customer_name || null,
            conversation_status: 'active',
            flow_state: flow,
            last_inbound_at: new Date().toISOString(),
            last_message_id: messageId,
          });
          const options = choices.map((slot, index) => `${index + 1}. ${slot.time} — ${slot.stylistName}`).join('\n');
          await logOutbound(service, connection, waId, `Available times on ${text}:\n${options}\n\nTime ka number reply karein.`);
        }
      }
    } else if (stage === 'choose_time') {
      const slots = Array.isArray(flow.availableSlots) ? flow.availableSlots as Row[] : [];
      const position = parseChoice(text, slots.length);
      if (position < 0) {
        const options = slots.map((slot, index) => `${index + 1}. ${slot.time} — ${slot.stylistName}`).join('\n');
        await logOutbound(service, connection, waId, `Time number sahi nahi hai.\n${options}`);
      } else {
        const selected = slots[position];
        flow = {
          ...flow,
          stage: 'enter_name',
          time: String(selected.time),
          stylistId: String(selected.stylistId),
          stylistName: String(selected.stylistName),
          branchId: selected.branchId || flow.branchId || null,
          branchName: selected.branchName || flow.branchName || null,
        };
        await saveConversation(service, connection.owner_id, waId, {
          customer_name: contactName || current?.customer_name || null,
          conversation_status: 'active',
          flow_state: flow,
          last_inbound_at: new Date().toISOString(),
          last_message_id: messageId,
        });
        await logOutbound(service, connection, waId, 'conversation', 'Booking ke liye apna naam bhejein.');
      }
    } else if (stage === 'enter_name') {
      const customerName = cleanText(text, 100);
      if (customerName.length < 2) {
        await logOutbound(service, connection, waId, 'conversation', 'Apna poora naam bhejein (kam se kam 2 letters).');
      } else {
        const selectedService = catalogue.services.find((item) => item.id === flow.serviceId);
        if (!selectedService) throw new Error('Selected service is no longer available.');
        const deposit = Math.ceil(selectedService.price * 25);
        flow = { ...flow, stage: 'await_confirmation', customerName };
        await saveConversation(service, connection.owner_id, waId, {
          customer_name: customerName,
          conversation_status: 'awaiting_confirmation',
          flow_state: flow,
          last_inbound_at: new Date().toISOString(),
          last_message_id: messageId,
        });
        await logOutbound(service, connection, waId, 'conversation',
          `Booking details check karein:\nService: ${selectedService.name}\nBranch: ${flow.branchName || 'Main salon'}\nDate: ${flow.date}\nTime: ${flow.time}\nSpecialist: ${flow.stylistName}\nTotal: ₹${selectedService.price}\nAdvance (25%): ₹${(deposit / 100).toFixed(2)}\n\nConfirm karne ke liye YES bhejein. Badalne ke liye MENU bhejein.`);
      }
    } else if (stage === 'await_confirmation') {
      if (lower !== 'yes' && lower !== 'confirm') {
        await logOutbound(service, connection, waId, 'conversation', 'Booking confirm karne ke liye YES bhejein. Dobara options dekhne ke liye MENU bhejein.');
      } else {
        const razorpayKey = env('RAZORPAY_KEY_ID');
        const razorpaySecret = env('RAZORPAY_KEY_SECRET');
        if (!razorpayKey || !razorpaySecret) {
          await logOutbound(service, connection, waId, 'conversation', 'Is salon ka online advance payment abhi setup nahi hua hai. Booking save nahi hui. Kripya salon se seedha sampark karein.');
        } else {
          const requestFingerprint = await hmacHex(env('META_APP_SECRET'), `${connection.owner_id}:${waId}:${messageId}`);
          const phone = normalizePhone(waId);
          const { data: booking, error: bookingError } = await service.rpc('studioflow_whatsapp_book_guest', {
            p_owner_id: connection.owner_id,
            p_service_id: String(flow.serviceId),
            p_branch_id: flow.branchId || null,
            p_date: String(flow.date),
            p_time: String(flow.time),
            p_stylist_id: String(flow.stylistId),
            p_customer_name: String(flow.customerName),
            p_customer_phone: phone,
            p_customer_wa_id: waId,
            p_idempotency_key: requestFingerprint,
          });
          if (bookingError || !booking?.id) {
            flow = { stage: 'choose_date', serviceId: flow.serviceId, serviceName: flow.serviceName, branchId: flow.branchId, branchName: flow.branchName };
            await saveConversation(service, connection.owner_id, waId, {
              customer_name: String(flow.customerName || current?.customer_name || ''),
              conversation_status: 'active',
              flow_state: flow,
              last_inbound_at: new Date().toISOString(),
              last_message_id: messageId,
            });
            await logOutbound(service, connection, waId, 'conversation', 'Ye time abhi available nahi hai ya booking save nahi hui. Kripya nayi date bhejein, main fresh times check karunga.');
          } else {
            const amountPaise = Math.ceil(Number(booking.servicePrice) * 25);
            const expireBy = Math.floor(new Date(String(booking.holdExpiresAt)).getTime() / 1000);
            const paymentResponse = await fetch('https://api.razorpay.com/v1/payment_links', {
              method: 'POST',
              headers: {
                Authorization: 'Basic ' + btoa(`${razorpayKey}:${razorpaySecret}`),
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                amount: amountPaise,
                currency: 'INR',
                accept_partial: false,
                expire_by: expireBy,
                reference_id: String(booking.id),
                description: `25% advance for ${cleanText(booking.serviceName, 100)}`,
                customer: { name: String(flow.customerName), contact: phone },
                notify: { sms: false, email: false },
                reminder_enable: false,
                notes: {
                  studioflow_booking: String(booking.id),
                  owner_id: connection.owner_id,
                  source: 'whatsapp',
                },
              }),
              signal: AbortSignal.timeout(20000),
            });
            const link = await paymentResponse.json().catch(() => ({})) as Row;
            if (!paymentResponse.ok || typeof link.id !== 'string' || typeof link.short_url !== 'string') {
              await service.from('studioflow_bookings').update({ status: 'cancelled', hold_expires_at: null }).eq('id', booking.id).eq('owner_id', connection.owner_id);
              throw new Error('Razorpay could not create the salon advance payment link.');
            }
            let orderId = typeof link.order_id === 'string' ? link.order_id : '';
            if (!orderId) {
              const fetchLink = await fetch(`https://api.razorpay.com/v1/payment_links/${encodeURIComponent(String(link.id))}`, {
                headers: { Authorization: 'Basic ' + btoa(`${razorpayKey}:${razorpaySecret}`) },
                signal: AbortSignal.timeout(15000),
              });
              const fetched = await fetchLink.json().catch(() => ({})) as Row;
              orderId = typeof fetched.order_id === 'string' ? fetched.order_id : '';
            }
            if (!orderId) {
              await fetch(`https://api.razorpay.com/v1/payment_links/${encodeURIComponent(String(link.id))}/cancel`, {
                method: 'POST',
                headers: { Authorization: 'Basic ' + btoa(`${razorpayKey}:${razorpaySecret}`) },
                signal: AbortSignal.timeout(15000),
              }).catch(() => null);
              await service.from('studioflow_bookings').update({ status: 'cancelled', hold_expires_at: null }).eq('id', booking.id).eq('owner_id', connection.owner_id);
              throw new Error('Payment provider did not return a verified booking order reference.');
            }
            const { data: registered, error: registerError } = await service.rpc('studioflow_register_payment', {
              p_booking: booking.id,
              p_order: orderId,
              p_amount: amountPaise,
            });
            if (registerError || !registered) {
              await fetch(`https://api.razorpay.com/v1/payment_links/${encodeURIComponent(String(link.id))}/cancel`, {
                method: 'POST',
                headers: { Authorization: 'Basic ' + btoa(`${razorpayKey}:${razorpaySecret}`) },
                signal: AbortSignal.timeout(15000),
              }).catch(() => null);
              await service.from('studioflow_bookings').update({ status: 'cancelled', hold_expires_at: null }).eq('id', booking.id).eq('owner_id', connection.owner_id);
              throw new Error('The payment link could not be safely attached to this booking.');
            }
            const { error: updateOrderError } = await service.from('studioflow_payment_orders')
              .update({
                payment_link_id: String(link.id),
                payment_link_url: String(link.short_url),
                payment_link_status: String(link.status || 'created'),
              })
              .eq('booking_id', booking.id);
            if (updateOrderError) throw new Error('The payment link was created but could not be saved against the booking.');

            await service.from('salon_whatsapp_message_log').insert({
              owner_id: connection.owner_id,
              salon_id: null,
              booking_id: booking.id,
              studioflow_payment_booking_id: booking.id,
              direction: 'outbound',
              recipient_wa_id: waId,
              message_kind: 'payment_link',
              delivery_status: 'queued',
              metadata: {
                paymentLinkId: link.id,
                paymentUrl: link.short_url,
                amountPaise,
                currency: 'INR',
              },
            });

            const paymentText = `Aapki booking request save ho gayi hai.\nBooking: ${String(booking.id).slice(0,8).toUpperCase()}\nAdvance (25%): ₹${(amountPaise / 100).toFixed(2)}\n\nPayment complete karne ke liye is secure link ko open karein:\n${link.short_url}\n\nPayment verify hote hi booking confirm hogi. Link 15 minute tak valid hai.`;
            await logOutbound(service, connection, waId, 'payment_link', paymentText, {
              bookingId: String(booking.id),
              paymentBookingId: String(booking.id),
              metadata: { paymentLinkId: link.id, amountPaise },
            });
            await saveConversation(service, connection.owner_id, waId, {
              customer_name: String(flow.customerName),
              conversation_status: 'awaiting_confirmation',
              flow_state: { ...flow, stage: 'awaiting_payment', bookingId: String(booking.id), paymentLinkId: String(link.id) },
              last_inbound_at: new Date().toISOString(),
              last_message_id: messageId,
            });
          }
        }
      }
    } else if (stage === 'awaiting_payment') {
      await logOutbound(service, connection, waId, 'conversation', 'Aapki booking ko confirm karne ke liye upar diya gaya advance payment link complete karein. Payment verify hote hi confirmation bhej di jayegi.');
    } else {
      await logOutbound(service, connection, waId, 'conversation', menuText(catalogue.businessName, catalogue.services));
      await saveConversation(service, connection.owner_id, waId, {
        conversation_status: 'active',
        flow_state: { stage: 'choose_service' },
        last_inbound_at: new Date().toISOString(),
        last_message_id: messageId,
      });
    }

    await service.from('salon_whatsapp_message_log').insert({
      owner_id: connection.owner_id,
      salon_id: null,
      direction: 'inbound',
      recipient_wa_id: waId,
      message_kind: 'conversation',
      delivery_status: 'received',
      metadata: { text, messageId, contactName: cleanText(contactName, 100) },
    });

    await service.from('salon_whatsapp_webhook_events')
      .update({ processing_status: 'processed', processed_at: new Date().toISOString() })
      .eq('provider_event_id', messageId);
  } catch (error) {
    await service.from('salon_whatsapp_webhook_events')
      .update({
        processing_status: 'failed',
        error_code: error instanceof Error ? error.message.slice(0, 180) : 'MESSAGE_PROCESSING_FAILED',
      })
      .eq('provider_event_id', messageId);
    // Meta may retry failed webhook deliveries; the failed event can be retried
    // safely because booking creation is guarded by the external idempotency key.
    throw error;
  }
}

async function handlePaymentSuccess(service: ReturnType<typeof createClient>, bookingId: string, paymentId: string, amountPaise: number) {
  const { data: booking, error } = await service
    .from('studioflow_bookings')
    .select('id,owner_id,booking_source,status,payload')
    .eq('id', bookingId)
    .maybeSingle();
  if (error || !booking || booking.booking_source !== 'whatsapp' || booking.status !== 'confirmed') {
    throw new Error('Verified WhatsApp booking was not found for payment confirmation.');
  }
  const { data: connection } = await service
    .from('salon_whatsapp_connections')
    .select('owner_id,phone_number_id,waba_id,access_token_ciphertext,access_token_iv,token_key_version,connection_status')
    .eq('owner_id', booking.owner_id)
    .eq('connection_status', 'connected')
    .maybeSingle();
  if (!connection) throw new Error('Salon WhatsApp number is not connected.');
  const payload = booking.payload as Row;
  const waId = cleanText(payload.customerWhatsAppId, 20);
  if (!/^\d{8,15}$/.test(waId)) throw new Error('Booking does not contain a valid customer WhatsApp ID.');

  const { data: prior } = await service
    .from('salon_whatsapp_message_log')
    .select('id')
    .eq('owner_id', booking.owner_id)
    .eq('booking_id', booking.id)
    .eq('message_kind', 'payment_success')
    .in('delivery_status', ['sent','delivered','read'])
    .limit(1)
    .maybeSingle();
  if (prior) return { sent: true, alreadySent: true };

  const { data: conversation } = await service
    .from('salon_whatsapp_conversations')
    .select('last_inbound_at')
    .eq('owner_id', booking.owner_id)
    .eq('customer_wa_id', waId)
    .maybeSingle();
  const recentWindowOpen = Boolean(conversation?.last_inbound_at)
    && Date.now() - new Date(String(conversation.last_inbound_at)).getTime() < 24 * 60 * 60 * 1000;
  const bookingRef = String(booking.id).slice(0, 8).toUpperCase();
  const amount = (amountPaise / 100).toFixed(2);
  const connectionRow = connection as Connection;
  const paymentText = `Payment receive ho gaya! ✅\nBooking ${bookingRef} ab confirm hai.\nService: ${cleanText(payload.serviceName, 100)}\nDate: ${cleanText(payload.date, 20)}\nTime: ${cleanText(payload.time, 20)}\nAdvance paid: ₹${amount}\n\nDhanyavaad!`;

  if (recentWindowOpen) {
    await logOutbound(service, connectionRow, waId, 'payment_success', paymentText, {
      bookingId: booking.id,
      paymentBookingId: booking.id,
      metadata: { paymentId, amountPaise, verified: true },
    });
  } else {
    const templateName = env('META_WHATSAPP_PAYMENT_SUCCESS_TEMPLATE');
    if (!templateName) {
      await service.from('salon_whatsapp_message_log').insert({
        owner_id: booking.owner_id,
        salon_id: null,
        booking_id: booking.id,
        studioflow_payment_booking_id: booking.id,
        direction: 'outbound',
        recipient_wa_id: waId,
        message_kind: 'payment_success',
        delivery_status: 'failed',
        error_code: 'APPROVED_PAYMENT_TEMPLATE_NOT_CONFIGURED',
        metadata: { paymentId, amountPaise, verified: true },
      });
      return { sent: false, reason: 'Approved WhatsApp payment-success template is not configured.' };
    }
    await logTemplate(service, connectionRow, waId, templateName, [
      cleanText(payload.clientName || payload.customerName, 100),
      bookingRef,
      amount,
      cleanText(payload.date, 20),
      cleanText(payload.time, 20),
    ], booking.id);
  }

  await service.from('salon_whatsapp_conversations')
    .update({ conversation_status: 'booked', flow_state: { stage: 'booked', bookingId: booking.id }, updated_at: new Date().toISOString() })
    .eq('owner_id', booking.owner_id)
    .eq('customer_wa_id', waId);

  return { sent: true };
}

async function handleDeliveryStatuses(service: ReturnType<typeof createClient>, statuses: Row[]) {
  for (const status of statuses) {
    const messageId = cleanText(status.id, 200);
    const deliveryStatus = cleanText(status.status, 20);
    if (!messageId || !['sent','delivered','read','failed'].includes(deliveryStatus)) continue;
    const errors = Array.isArray(status.errors) ? status.errors as Row[] : [];
    await service.from('salon_whatsapp_message_log')
      .update({
        delivery_status: deliveryStatus,
        error_code: errors[0] ? String(errors[0].code || 'WHATSAPP_DELIVERY_FAILED').slice(0, 80) : null,
        updated_at: new Date().toISOString(),
      })
      .eq('provider_message_id', messageId);
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const mode = url.searchParams.get('hub.mode') || '';
    const token = url.searchParams.get('hub.verify_token') || '';
    const challenge = url.searchParams.get('hub.challenge') || '';
    if (mode === 'subscribe' && env('META_WEBHOOK_VERIFY_TOKEN') && safeEqual(token, env('META_WEBHOOK_VERIFY_TOKEN'))) {
      return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
    }
    return response('Forbidden', 403, { 'Content-Type': 'text/plain' });
  }

  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors(request) });
  if (request.method !== 'POST') return response({ error: 'Method not allowed.' }, 405);

  try {
    const supabaseUrl = env('SUPABASE_URL');
    const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) return response({ error: 'WhatsApp webhook service is not configured.' }, 503);
    const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const raw = await request.text();
    if (raw.length > 1024 * 1024) return response({ error: 'Webhook payload too large.' }, 413);

    // Payment success events come only from the existing server-side Razorpay
    // settlement function using the service-role secret. This path is not public.
    const internalKey = request.headers.get('x-nexora-internal-key') || '';
    if (internalKey && safeEqual(internalKey, serviceKey)) {
      let body: Row;
      try { body = JSON.parse(raw || '{}') as Row; } catch { return response({ error: 'Invalid JSON.' }, 400); }
      if (body.action === 'payment_success') {
        const bookingId = typeof body.bookingId === 'string' ? body.bookingId : '';
        const paymentId = typeof body.paymentId === 'string' ? body.paymentId : '';
        const amountPaise = Number(body.amountPaise);
        if (!/^[0-9a-f-]{36}$/i.test(bookingId) || !paymentId || !Number.isInteger(amountPaise) || amountPaise < 100) {
          return response({ error: 'Invalid internal payment confirmation.' }, 400);
        }
        const result = await handlePaymentSuccess(service, bookingId, paymentId, amountPaise);
        return response({ ok: true, ...result });
      }
      return response({ error: 'Unknown internal action.' }, 400);
    }

    const signature = request.headers.get('x-hub-signature-256') || '';
    if (!await signatureMatches(raw, signature)) return response({ error: 'Invalid Meta webhook signature.' }, 401);

    let payload: Row;
    try { payload = JSON.parse(raw || '{}') as Row; }
    catch { return response({ error: 'Invalid Meta webhook JSON.' }, 400); }

    if (payload.object !== 'whatsapp_business_account') return response({ received: true, ignored: true });
    const entries = Array.isArray(payload.entry) ? payload.entry as Row[] : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes as Row[] : [];
      for (const change of changes) {
        const value = (change.value || {}) as Row;
        const metadata = (value.metadata || {}) as Row;
        const phoneNumberId = cleanText(metadata.phone_number_id, 80);
        if (!phoneNumberId) continue;
        const connection = await getConnectionByPhone(service, phoneNumberId);
        if (!connection) continue;

        const statuses = Array.isArray(value.statuses) ? value.statuses as Row[] : [];
        if (statuses.length) await handleDeliveryStatuses(service, statuses);

        const contacts = Array.isArray(value.contacts) ? value.contacts as Row[] : [];
        const messages = Array.isArray(value.messages) ? value.messages as Row[] : [];
        for (const message of messages) {
          const from = cleanText(message.from, 20);
          const contact = contacts.find((candidate) => String(candidate.wa_id || '') === from);
          const profile = (contact?.profile || {}) as Row;
          await processCustomerMessage(service, connection, message, cleanText(profile.name, 100));
        }
      }
    }

    return response({ received: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'WhatsApp webhook could not be processed.';
    return response({ error: message }, 500);
  }
});
