-- NEXORA WhatsApp booking integration: isolated QA ledger only.
-- These rows are deliberately separate from studioflow_bookings and never
-- hold/reserve a live calendar slot or trigger payment/loyalty workflows.

create table if not exists public.studioflow_whatsapp_test_bookings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.studioflow_accounts(user_id) on delete cascade,
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  customer_name text not null check (char_length(btrim(customer_name)) between 2 and 100),
  customer_phone_hash text not null check (customer_phone_hash ~ '^[a-f0-9]{64}$'),
  customer_phone_last4 text not null check (customer_phone_last4 ~ '^[0-9]{4}$'),
  service_ids text[] not null check (cardinality(service_ids) between 1 and 10),
  stylist_id text not null,
  branch_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'test_only' check (status = 'test_only'),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint studioflow_whatsapp_test_bookings_request_unique unique (owner_id, request_id),
  constraint studioflow_whatsapp_test_bookings_time_check check (ends_at > starts_at)
);

create index if not exists studioflow_whatsapp_test_bookings_owner_created_idx
  on public.studioflow_whatsapp_test_bookings(owner_id, created_at desc);

alter table public.studioflow_whatsapp_test_bookings enable row level security;
revoke all on table public.studioflow_whatsapp_test_bookings from public, anon, authenticated;
grant select, insert, update, delete on table public.studioflow_whatsapp_test_bookings to service_role;

comment on table public.studioflow_whatsapp_test_bookings is
  'Private test-only WhatsApp booking simulation records. Never reserves the live studioflow_bookings calendar and is excluded from payment, loyalty and revenue flows.';
