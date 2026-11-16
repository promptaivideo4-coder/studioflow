import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const connect = read('supabase/functions/nexora-whatsapp-connect/index.ts');
const webhook = read('supabase/functions/nexora-whatsapp-webhook/index.ts');
const payments = read('supabase/functions/studioflow-payments/index.ts');
const bookingSql = read('supabase/migrations/20261116030205_nexora_whatsapp_guest_booking.sql');
const workspace = read('src/components/OwnerWorkspace.tsx');
const panel = read('src/components/NexoraWhatsAppIntegration.tsx');
const nav = read('src/lib/ownerNavigation.ts');

for (const required of [
  'service.auth.getUser(token)',
  'state_hash: stateHash',
  'consumed_at: new Date().toISOString()',
  "AES-GCM",
  "meta_embedded_signup_v4",
  "phone_number_id",
  "subscribed_apps",
]) assert.ok(connect.includes(required), `Meta connection security contract missing: ${required}`);

assert.ok(connect.includes("eq('owner_id', ownerId)"), 'Meta connection must be scoped to the signed-in salon owner');
assert.ok(connect.includes('access_token_ciphertext'), 'Meta access token must be stored encrypted');
assert.ok(!connect.includes('return json(request, { accessToken'), 'Meta token must never be returned to the browser');

for (const required of [
  'x-hub-signature-256',
  'signatureMatches(raw, signature)',
  "eq('phone_number_id', phoneNumberId)",
  "provider_event_id: messageId",
  "stage: 'await_confirmation'",
  "lower !== 'yes' && lower !== 'confirm'",
  'studioflow_whatsapp_book_guest',
  "booking_source",
  'payment_links',
  "lower === 'stop' || lower === 'unsubscribe'",
]) assert.ok(webhook.includes(required), `WhatsApp webhook contract missing: ${required}`);

assert.ok(webhook.includes("prior?.processing_status === 'processing'"), 'Webhook must not process an in-flight duplicate message twice');
assert.ok(webhook.includes("row.booking_source !== 'whatsapp'"), 'Payment notices must be scoped to WhatsApp-originated bookings');
assert.ok(webhook.includes("env('META_APP_SECRET')"), 'Meta raw-body signatures must use the Meta app secret');

assert.ok(bookingSql.includes('alter column customer_id drop not null'), 'WhatsApp customer must not need an app login');
assert.ok(bookingSql.includes("booking_source,external_idempotency_key"), 'Guest booking must be source-attributed and idempotent');
assert.ok(bookingSql.includes("'whatsapp'"), 'Guest booking must be marked as WhatsApp source');
assert.ok(bookingSql.includes('to service_role'), 'Guest booking RPC must be restricted to trusted server-side role');
assert.ok(bookingSql.includes('studioflow_branch_android_slots'), 'Guest booking must check live branch availability');
assert.ok(bookingSql.includes('studioflow_android_slots'), 'Guest booking must check live single-location availability');

assert.ok(payments.includes('studioflow_settle_payment'), 'Razorpay must use the canonical payment settlement RPC');
assert.ok(payments.includes('notifyWhatsAppPaymentSuccess'), 'Verified settlement must trigger the WhatsApp payment notice');
assert.ok(payments.indexOf('await notifyWhatsAppPaymentSuccess(order.booking_id,paymentId,payment.amount)') > payments.indexOf('studioflow_settle_payment'), 'WhatsApp notice must run only after the payment settlement RPC');
assert.ok(payments.includes("booking.booking_source!=='whatsapp'"), 'Only WhatsApp bookings may trigger the WhatsApp notice');
assert.ok(payments.includes("'x-nexora-internal-key':serviceKey"), 'Internal payment notices must authenticate with the service key');

assert.ok(nav.includes("{id:34,label:'WhatsApp bookings & payments'"), 'WhatsApp module must appear in owner navigation');
assert.ok(workspace.includes("if (active === 34) return <NexoraWhatsAppIntegration />"), 'Shared OwnerWorkspace must mount WhatsApp panel for all salon templates');
assert.ok(panel.includes("supabase.functions.invoke('nexora-whatsapp-connect'"), 'Owner panel must call the server-side connection function');
assert.ok(panel.includes('Connect my WhatsApp'), 'Owner panel must offer per-salon WhatsApp onboarding');
assert.ok(panel.includes('missingConfiguration'), 'Owner panel must disclose missing Meta settings instead of showing a fake connection');
assert.ok(panel.includes('advanceCollectedINR'), 'Owner panel must display real WhatsApp advance collection totals');

console.log('PASS: NEXORA salon-owned WhatsApp connection, booking, payment and owner-panel contracts.');
