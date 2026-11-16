-- Secure guest booking adapter for salon-owned WhatsApp conversations.
-- Guest customers do not need a NEXORA app account; the salon owner still owns
-- the booking and the existing calendar/payment lifecycle remains authoritative.

alter table public.studioflow_bookings
  alter column customer_id drop not null,
  add column if not exists booking_source text not null default 'website',
  add column if not exists external_idempotency_key text;

alter table public.studioflow_bookings
  drop constraint if exists studioflow_bookings_booking_source_check;

alter table public.studioflow_bookings
  add constraint studioflow_bookings_booking_source_check
  check (booking_source in ('website','whatsapp','app','manual'));


create unique index if not exists studioflow_bookings_owner_external_idempotency_uidx
  on public.studioflow_bookings(owner_id, external_idempotency_key)
  where external_idempotency_key is not null;

create index if not exists studioflow_bookings_owner_whatsapp_created_idx
  on public.studioflow_bookings(owner_id, created_at desc)
  where booking_source = 'whatsapp';

alter table public.salon_whatsapp_connections
  add column if not exists is_on_biz_app boolean not null default false,
  add column if not exists platform_type text,
  add column if not exists primary_waac_ids jsonb not null default '[]'::jsonb,
  add column if not exists connection_mode text not null default 'standard';

alter table public.salon_whatsapp_conversations
  add column if not exists is_opted_out boolean not null default false,
  add column if not exists opted_out_at timestamptz,
  add column if not exists consent_recorded_at timestamptz,
  add column if not exists last_message_id text;

create index if not exists salon_whatsapp_conversations_owner_optout_idx
  on public.salon_whatsapp_conversations(owner_id, is_opted_out, updated_at desc);

create or replace function public.studioflow_whatsapp_book_guest(
  p_owner_id uuid,
  p_service_id text,
  p_branch_id uuid,
  p_date date,
  p_time text,
  p_stylist_id text,
  p_customer_name text,
  p_customer_phone text,
  p_customer_wa_id text,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection public.salon_whatsapp_connections;
  v_website public.studioflow_websites;
  v_service jsonb;
  v_staff jsonb;
  v_candidate jsonb;
  v_slots jsonb;
  v_draft jsonb;
  v_schedule jsonb;
  v_day_entry jsonb;
  v_branch_count integer := 0;
  v_start timestamptz;
  v_end timestamptz;
  v_booking_id uuid := gen_random_uuid();
  v_booking_payload jsonb;
  v_existing public.studioflow_bookings;
  v_name text := left(btrim(coalesce(p_customer_name,'')),100);
  v_phone text := left(btrim(coalesce(p_customer_phone,'')),24);
  v_wa_id text := regexp_replace(coalesce(p_customer_wa_id,''),'[^0-9]','','g');
  v_idempotency text := btrim(coalesce(p_idempotency_key,''));
begin
  if p_owner_id is null
    or p_service_id is null or btrim(p_service_id) = ''
    or p_date is null or p_date < (now() at time zone 'Asia/Kolkata')::date
    or p_date > (now() at time zone 'Asia/Kolkata')::date + 90
    or coalesce(p_time,'') !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
    or coalesce(p_stylist_id,'') = ''
    or length(v_name) < 2
    or length(regexp_replace(v_phone,'[^0-9]','','g')) not between 10 and 15
    or length(v_wa_id) not between 8 and 15
    or v_idempotency !~ '^[a-f0-9]{64}$'
  then
    raise exception 'Invalid WhatsApp booking details' using errcode='22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':whatsapp:' || v_idempotency,0));

  select * into v_existing
  from public.studioflow_bookings
  where owner_id=p_owner_id and external_idempotency_key=v_idempotency
  limit 1;
  if v_existing.id is not null then
    return v_existing.payload || jsonb_build_object('idempotentRetry',true);
  end if;

  select * into v_connection
  from public.salon_whatsapp_connections
  where owner_id=p_owner_id
    and connection_status='connected'
    and webhook_subscribed=true
  for share;
  if v_connection.id is null then
    raise exception 'This salon WhatsApp number is not connected' using errcode='42501';
  end if;

  select * into v_website
  from public.studioflow_websites
  where owner_id=p_owner_id;
  if v_website.owner_id is null then
    raise exception 'Publish this salon website before accepting WhatsApp bookings';
  end if;

  select service into v_service
  from jsonb_array_elements(coalesce(v_website.content->'services','[]'::jsonb)) service
  where service->>'id'=p_service_id
  limit 1;
  if v_service is null
    or coalesce(btrim(v_service->>'name'),'')=''
    or coalesce((v_service->>'price')::numeric,0)<0
    or coalesce((v_service->>'durationMinutes')::integer,0) not between 1 and 720
  then
    raise exception 'That service is no longer available';
  end if;

  select count(*) into v_branch_count
  from public.branches
  where site_id=p_owner_id and is_active;

  if v_branch_count>1 and p_branch_id is null then
    raise exception 'Choose a salon branch before booking';
  end if;
  if v_branch_count=1 and p_branch_id is null then
    select id into p_branch_id
    from public.branches
    where site_id=p_owner_id and is_active
    order by created_at asc
    limit 1;
  end if;
  if p_branch_id is not null and not exists(
    select 1 from public.branches
    where site_id=p_owner_id and id=p_branch_id and is_active
  ) then
    raise exception 'That salon branch is not active';
  end if;

  if p_branch_id is null then
    select slots into v_slots
    from (select public.studioflow_android_slots(
      v_website.slug,
      jsonb_build_array(p_service_id),
      p_date,
      p_stylist_id
    ) as slots) q;
  else
    select slots into v_slots
    from (select public.studioflow_branch_android_slots(
      v_website.slug,
      jsonb_build_array(p_service_id),
      p_date,
      p_stylist_id,
      p_branch_id
    ) as slots) q;
  end if;

  select slot into v_candidate
  from jsonb_array_elements(coalesce(v_slots,'[]'::jsonb)) slot
  where slot->>'time'=p_time
    and coalesce((slot->>'available')::boolean,true)
    and (p_stylist_id in ('any','any-specialist','any_available') or slot->>'stylistId'=p_stylist_id)
  limit 1;
  if v_candidate is null or coalesce(v_candidate->>'stylistId','')='' then
    raise exception 'That time is no longer available. Please choose another slot';
  end if;

  select staff into v_staff
  from jsonb_array_elements(coalesce(v_website.content->'stylists','[]'::jsonb)) staff
  where staff->>'id'=v_candidate->>'stylistId'
  limit 1;
  if v_staff is null or coalesce(v_staff->>'status','Available')<>'Available' then
    raise exception 'The selected specialist is no longer available';
  end if;

  v_start := ((p_date::text || ' ' || p_time)::timestamp) at time zone 'Asia/Kolkata';
  v_end := v_start + greatest(1,(v_service->>'durationMinutes')::integer)*interval '1 minute';
  if v_start <= now() or v_start > now()+interval '90 days' then
    raise exception 'Choose a future appointment within 90 days';
  end if;

  if p_branch_id is null then
    select draft into v_draft
    from public.studioflow_accounts
    where user_id=p_owner_id;

    select staff->'schedule' into v_schedule
    from jsonb_array_elements(coalesce(v_draft->'stylists','[]'::jsonb)) staff
    where staff->>'id'=v_staff->>'id'
    limit 1;

    if v_schedule is not null and jsonb_typeof(v_schedule)='array' and jsonb_array_length(v_schedule)>0 then
      select entry into v_day_entry
      from jsonb_array_elements(v_schedule) entry
      where entry->>'day'=trim(to_char(v_start at time zone 'Asia/Kolkata','Day'))
      limit 1;
      if v_day_entry is null
        or not coalesce((v_day_entry->>'enabled')::boolean,false)
        or (v_start at time zone 'Asia/Kolkata')::time < (v_day_entry->>'fromTime')::time
        or (v_end at time zone 'Asia/Kolkata')::time > (v_day_entry->>'toTime')::time
      then
        raise exception 'The selected specialist is unavailable at this time';
      end if;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || (v_staff->>'id'),0));
  if exists(
    select 1
    from public.studioflow_bookings other
    where other.owner_id=p_owner_id
      and other.stylist_id=v_staff->>'id'
      and other.status in ('pending','confirmed')
      and (other.status='confirmed' or other.hold_expires_at is null or other.hold_expires_at>now())
      and other.starts_at<v_end
      and other.ends_at>v_start
  ) then
    raise exception 'That time has just been booked. Please choose another slot';
  end if;

  v_booking_payload := jsonb_build_object(
    'id',v_booking_id,
    'clientName',v_name,
    'clientPhone',v_phone,
    'serviceId',v_service->>'id',
    'serviceName',v_service->>'name',
    'servicePrice',(v_service->>'price')::numeric,
    'stylistId',v_staff->>'id',
    'stylistName',v_staff->>'name',
    'branchId',p_branch_id,
    'branchName',coalesce(v_candidate->>'branchName',''),
    'date',p_date::text,
    'time',p_time,
    'status','pending',
    'paymentStatus','unpaid',
    'amountPaid',0,
    'source','whatsapp',
    'bookingSource','whatsapp',
    'customerWhatsAppId',v_wa_id,
    'createdAt',now()
  );

  insert into public.studioflow_bookings(
    id,owner_id,customer_id,stylist_id,starts_at,ends_at,status,payload,
    hold_expires_at,branch_id,booking_source,external_idempotency_key
  ) values (
    v_booking_id,p_owner_id,null,v_staff->>'id',v_start,v_end,'pending',
    v_booking_payload,now()+interval '15 minutes',p_branch_id,'whatsapp',v_idempotency
  );

  return v_booking_payload || jsonb_build_object(
    'holdExpiresAt',now()+interval '15 minutes',
    'salonName',coalesce(v_website.content->'profile'->>'businessName','Salon')
  );
end
$$;

revoke all on function public.studioflow_whatsapp_book_guest(uuid,text,uuid,date,text,text,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.studioflow_whatsapp_book_guest(uuid,text,uuid,date,text,text,text,text,text,text)
  to service_role;

comment on function public.studioflow_whatsapp_book_guest(uuid,text,uuid,date,text,text,text,text,text,text) is
  'Service-role-only atomic guest booking adapter for verified salon-owned WhatsApp senders. Rechecks live availability, stores booking_source=whatsapp and enforces idempotency.';
