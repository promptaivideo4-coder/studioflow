# NEXORA salon-owned WhatsApp booking and payments

## Product behavior

Every published salon tenant uses its own WhatsApp Business Platform sender. Template choice is only presentation; the tenant is resolved from the verified Meta `phone_number_id` on inbound webhooks, never from a customer-supplied slug alone. The same salon identity is used for customer replies, booking updates, payment links and payment receipts.

The central NEXORA number remains support/fallback only. It must not be used as the sender for another salon's booking or payment messages.

## Tenant and credential boundaries

- One `salon_whatsapp_connections` row per StudioFlow salon owner, keyed by `studioflow_accounts.user_id` and linked to that owner's published `studioflow_websites` record.
- Unique `phone_number_id` prevents a WhatsApp sender being assigned to two salons.
- Meta access tokens must be AES-256-GCM encrypted in a trusted Edge Function before storage. The encryption key is a Supabase Function secret, never a browser variable or database column.
- OAuth state is random, single-use, short-lived and stored as a SHA-256 hash. Bind the callback to the initiating authenticated StudioFlow owner and their `studioflow_accounts.user_id`.
- Browser roles cannot read or write connection tokens, OAuth state, webhook payloads, conversations or message logs. Trusted Edge Functions use the service role.
- Inbound webhooks must verify Meta's `X-Hub-Signature-256` against the raw request body before parsing or processing.
- Resolve tenant from the inbound `metadata.phone_number_id` and the active connection. Ignore unrecognised or disconnected numbers.
- Deduplicate webhook events and outbound sends. Never let a webhook body choose an arbitrary salon or booking owner.

## Booking conversation

1. Receive a customer message on the salon's connected number.
2. Resolve that number to one active salon connection.
3. Read only that salon's public services, prices, staff and live availability.
4. Collect customer name, phone, service, branch (when required), stylist (optional), date and time.
5. Re-check availability on the server immediately before reservation.
6. Present the complete booking summary and require an explicit customer confirmation.
7. Create the appointment through the existing StudioFlow booking/reservation service with `booking_source = 'whatsapp'`, an idempotency key and the tenant's actual `owner_id`.
8. If a slot was taken or booking save fails, do not say the booking is confirmed; offer refreshed slots.
9. Write the booking reference to the message log and dashboard metrics.

WhatsApp guest booking must reuse the existing booking rules and server-side availability checks. It must not insert directly into booking tables from a public webhook handler.

## Payments and WhatsApp messages

- Create payment orders through the salon's already configured live payment provider and the canonical payment service.
- Send a provider-hosted payment URL using the same salon WhatsApp sender. Never collect card data, UPI PINs or OTPs in chat.
- Mark an order paid only after a verified provider webhook/signature confirms capture. Customer messages and screenshots are never proof of payment.
- Send payment success/failure/receipt messages only after server-side payment status is verified.
- Use approved WhatsApp message templates for business-initiated messages outside the customer-service window. Capture opt-in and respect opt-out.
- Persist delivery state in `salon_whatsapp_message_log` for dashboard metrics and troubleshooting.

## Owner app dashboard

Add a WhatsApp channel setup card under salon integrations:
- Connect WhatsApp (Meta Embedded Signup)
- Connected business display name and number
- Connection / webhook health, last message, reconnect and disconnect
- Explicit opt-in and notification template readiness

Add a WhatsApp bookings and payments view:
- WhatsApp enquiries, booking requests, confirmed bookings and cancellations
- Revenue/advance collected for WhatsApp-originated bookings
- Payment links sent, paid, failed and pending
- Message delivery statuses and human handoff

Metrics must be derived from StudioFlow booking/payment rows and message logs, not increment-only counters. Use `studioflow_bookings.payload` and the canonical owner/booking records for source attribution, plus verified `studioflow_payment_orders` rows for collected amounts.

## Rollout gates

1. Meta business verification, Tech Provider / Embedded Signup access, App Review and the required `whatsapp_business_messaging` and `whatsapp_business_management` permissions.
2. Add Supabase Edge Function secrets: `META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID`, `META_GRAPH_API_VERSION`, `META_WEBHOOK_VERIFY_TOKEN`, `META_TOKEN_ENCRYPTION_KEY`, and existing Razorpay live/webhook credentials. Add `META_WHATSAPP_PAYMENT_SUCCESS_TEMPLATE` and `META_WHATSAPP_TEMPLATE_LANGUAGE` for notifications outside the 24-hour service window. Never paste secrets into chat or commit them.
3. Complete a Meta Embedded Signup v4 test with a real salon business and verify the returned phone number belongs to the selected WABA.
4. Complete a live inbound test message, then confirm the reply is sent from that salon's connected phone number.
5. Complete an end-to-end test booking: explicit YES confirmation, live slot recheck, owner calendar entry, 25% Razorpay payment link, verified payment webhook, booking confirmation and WhatsApp receipt.
6. Run isolation tests across at least two salons and all 16 template renderers, including wrong-tenant, duplicate/replayed webhook, expired token, duplicate booking, unavailable slot, failed payment, STOP opt-out and webhook retry cases.
7. Enable production for public salon owners only after Meta approval, provider live configuration and successful end-to-end verification.

## Current implementation status

**Already applied to the production Supabase database:** the five WhatsApp connection, OAuth, event, conversation and message-log tables; RLS and browser-role access revocation; canonical StudioFlow owner/booking/payment mapping.

**Added in the current implementation branch (not yet merged or deployed):**
- Owner dashboard panel to connect, view, and disconnect each salon's own WhatsApp number.
- Meta code exchange, single-use owner-bound OAuth state, WABA phone ownership validation and AES-256-GCM token encryption.
- Meta webhook signature verification, phone-number-ID tenant routing, inbound/delivery event deduplication, customer opt-out and an interactive booking conversation.
- Service-role-only guest booking RPC that rechecks current slots, branch/staff availability, stores `booking_source='whatsapp'`, and applies idempotency.
- Razorpay payment-link creation for the existing 25% advance rule, plus a payment-success notice after the existing verified settlement RPC.

**Not live yet:** the new guest-booking migration, two WhatsApp Edge Functions, owner panel and payment-notice hook still need final CI, merge and deployment. No salon WhatsApp number is connected yet. Production use also requires the Meta app/configuration/approval and the server secrets listed above. Do not present a salon as connected until Meta has returned and NEXORA has verified its actual WABA phone number.

## Migration history recovery

The live project contains historical migration versions that are not present as files in this repository. Do not mark those versions reverted or add empty placeholder migrations: either action can break a fresh preview rebuild or cause already-applied SQL to run again. Before enabling Supabase branch previews, generate and review a complete baseline from the live schema with the Supabase CLI (`supabase db pull`), verify a clean local reset against that baseline, and then reconcile migration history deliberately. The WhatsApp foundation and StudioFlow tenancy migrations are tracked using the exact versions recorded by the live project (`20261115173757` and `20261115174514`).
