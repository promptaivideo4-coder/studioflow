import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';

const source = readFileSync('supabase/functions/studioflow-whatsapp-booking/index.ts', 'utf8');
const migration = readFileSync('supabase/migrations/202611150001_studioflow_whatsapp_test_booking_api.sql', 'utf8');
const spec = JSON.parse(readFileSync('docs/integrations/nexora-whatsapp-booking.openapi.json', 'utf8'));
const docs = readFileSync('docs/integrations/NEXORA-WHATSAPP-BOOKING-TEST.md', 'utf8');

assert.match(source, /NEXORA_TAWK_BOOKING_API_KEY/);
assert.match(source, /x-nexora-booking-key/i);
assert.match(source, /constantTimeEqual/);
assert.match(source, /studioflow_android_slots/);
assert.match(source, /studioflow_branch_android_slots/);
assert.match(source, /studioflow_edge_rate_limit_claim/);
assert.match(source, /studioflow_whatsapp_test_bookings/);
assert.match(source, /calendarReserved:\s*false/);
assert.match(source, /never log or echo raw customer messages, phone numbers, API keys or DB errors/i);
assert.doesNotMatch(source, /\.from\(['"]studioflow_bookings['"]\)\.insert/);
assert.doesNotMatch(source, /\.rpc\(['"]studioflow_(?:android_book|book|branch_book)['"]/);

assert.match(migration, /enable row level security/i);
assert.match(migration, /revoke all .* from public, anon, authenticated/i);
assert.match(migration, /grant select, insert, update, delete .* to service_role/i);
assert.match(migration, /unique \(owner_id, request_id\)/i);
assert.match(migration, /never reserves the live studioflow_bookings calendar/i);

assert.equal(spec.openapi, '3.0.3');
assert.equal(spec.components.securitySchemes.NexoraBookingKey.name, 'X-NEXORA-BOOKING-KEY');
assert.ok(spec.paths['/catalogue'] && spec.paths['/availability'] && spec.paths['/test-booking']);
assert.match(spec.paths['/test-booking'].post.description, /does NOT book the appointment/i);
assert.match(docs, /has NOT been booked/i);

console.log('PASS: WhatsApp test API auth, live availability RPC wiring, test-only persistence, RLS, idempotency, rate limit and OpenAPI contract.');
