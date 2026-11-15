import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';

const source = readFileSync('supabase/functions/studioflow-whatsapp-booking/index.ts', 'utf8');
const migration = readFileSync('supabase/migrations/20261115132100_studioflow_whatsapp_test_booking_api.sql', 'utf8');
const spec = JSON.parse(readFileSync('docs/integrations/nexora-whatsapp-booking.openapi.json', 'utf8'));
const docs = readFileSync('docs/integrations/NEXORA-WHATSAPP-BOOKING-TEST.md', 'utf8');
const renameMigration = readFileSync('supabase/migrations/20261115133000_private_whatsapp_test_rate_limit.sql', 'utf8');

assert.match(source, /NEXORA_TAWK_BOOKING_API_KEY/);
assert.ok(source.includes("req.headers.get('authorization')"));
assert.ok(source.includes("Bearer\\s+"));
assert.match(source, /constantTimeEqual/);
assert.match(source, /studioflow_android_slots/);
assert.match(source, /studioflow_branch_android_slots/);
assert.match(source, /private_whatsapp_test_rate_limit/);
assert.ok(source.includes('if (body.customerConfirmed !== true)'));
assert.match(source, /Choose a salon location before checking times/);
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
assert.match(migration, /private_whatsapp_test_rate_limit/i);
assert.match(renameMigration, /studioflow_whatsapp_test_rate_limit/i);
assert.match(renameMigration, /rename to private_whatsapp_test_rate_limit/i);

assert.equal(spec.openapi, '3.0.3');
assert.equal(spec.components.securitySchemes.NexoraBookingKey.type, 'http');
assert.equal(spec.components.securitySchemes.NexoraBookingKey.scheme, 'bearer');
assert.ok(spec.paths['/catalogue'] && spec.paths['/availability'] && spec.paths['/test-booking']);
assert.match(spec.paths['/test-booking'].post.description, /does NOT book the appointment/i);
assert.ok(spec.components.schemas.TestBookingRequest.required.includes('customerConfirmed'));
assert.match(docs, /has NOT been booked/i);
assert.match(docs, /Authorization: Bearer/i);

console.log('PASS: WhatsApp test API auth, live availability RPC wiring, test-only persistence, RLS, idempotency, rate limit and OpenAPI contract.');
