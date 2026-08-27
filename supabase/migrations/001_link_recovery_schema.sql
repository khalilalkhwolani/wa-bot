begin;

create extension if not exists pgcrypto;

create table if not exists public.system_counters (
  counter_key text primary key,
  counter_value bigint not null default 0 check (counter_value >= 0),
  updated_at timestamptz not null default now()
);

insert into public.system_counters (counter_key, counter_value)
values ('link_display_serial', 0)
on conflict (counter_key) do nothing;

create table if not exists public.links (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  link_type text not null check (link_type in ('group', 'channel')),
  invite_code text not null,
  url text not null,
  status text not null default 'pending'
    check (status in ('historically_sent', 'observed_unconfirmed', 'pending', 'sent', 'failed')),
  display_serial bigint unique,
  legacy_first_serial bigint,
  legacy_last_serial bigint,
  occurrence_count integer not null default 1 check (occurrence_count > 0),
  first_observed_at timestamptz,
  last_observed_at timestamptz,
  first_sent_at timestamptz,
  last_sent_at timestamptz,
  discovered_by_session text,
  source_group_jid text,
  source_group_name text,
  last_whatsapp_message_id text,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists links_status_idx on public.links (status);
create index if not exists links_last_observed_at_idx on public.links (last_observed_at desc);
create index if not exists links_display_serial_idx on public.links (display_serial desc) where display_serial is not null;

create table if not exists public.link_occurrences (
  id bigint generated always as identity primary key,
  link_id uuid not null references public.links(id) on delete restrict,
  event_fingerprint text unique,
  observed_at timestamptz not null default now(),
  session_id text,
  source_group_jid text,
  source_group_name text,
  source_message_id text,
  source_sender_jid text,
  raw_url text not null,
  outcome text not null default 'observed'
    check (outcome in ('observed', 'duplicate', 'claimed', 'sent', 'failed', 'historical_import')),
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists link_occurrences_link_id_idx on public.link_occurrences (link_id);
create index if not exists link_occurrences_observed_at_idx on public.link_occurrences (observed_at desc);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists links_touch_updated_at on public.links;
create trigger links_touch_updated_at
before update on public.links
for each row execute function public.touch_updated_at();

drop trigger if exists system_counters_touch_updated_at on public.system_counters;
create trigger system_counters_touch_updated_at
before update on public.system_counters
for each row execute function public.touch_updated_at();

create or replace function public.claim_link_for_sending(
  p_canonical_key text,
  p_link_type text,
  p_invite_code text,
  p_url text,
  p_session_id text,
  p_source_group_jid text default null,
  p_source_group_name text default null,
  p_source_message_id text default null,
  p_source_sender_jid text default null,
  p_observed_at timestamptz default now()
)
returns table (
  link_id uuid,
  display_serial bigint,
  should_send boolean,
  current_status text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_link public.links%rowtype;
  v_serial bigint;
  v_fingerprint text;
begin
  if p_link_type not in ('group', 'channel') then
    raise exception 'Unsupported link type: %', p_link_type;
  end if;

  insert into public.links (
    canonical_key,
    link_type,
    invite_code,
    url,
    status,
    first_observed_at,
    last_observed_at,
    discovered_by_session,
    source_group_jid,
    source_group_name
  ) values (
    lower(p_canonical_key),
    p_link_type,
    p_invite_code,
    p_url,
    'pending',
    p_observed_at,
    p_observed_at,
    p_session_id,
    p_source_group_jid,
    p_source_group_name
  )
  on conflict (canonical_key) do update set
    occurrence_count = public.links.occurrence_count + 1,
    last_observed_at = greatest(public.links.last_observed_at, excluded.last_observed_at),
    url = excluded.url
  returning * into v_link;

  v_fingerprint := encode(
    digest(
      concat_ws('|', lower(p_canonical_key), coalesce(p_session_id, ''), coalesce(p_source_message_id, '')),
      'sha256'
    ),
    'hex'
  );

  insert into public.link_occurrences (
    link_id,
    event_fingerprint,
    observed_at,
    session_id,
    source_group_jid,
    source_group_name,
    source_message_id,
    source_sender_jid,
    raw_url,
    outcome
  ) values (
    v_link.id,
    v_fingerprint,
    p_observed_at,
    p_session_id,
    p_source_group_jid,
    p_source_group_name,
    p_source_message_id,
    p_source_sender_jid,
    p_url,
    case when v_link.status in ('historically_sent', 'sent', 'pending') and v_link.display_serial is not null
      then 'duplicate'
      else 'observed'
    end
  )
  on conflict (event_fingerprint) do nothing;

  if v_link.status in ('historically_sent', 'sent') then
    return query select v_link.id, v_link.display_serial, false, v_link.status;
    return;
  end if;

  if v_link.status = 'pending' and v_link.display_serial is not null then
    return query select v_link.id, v_link.display_serial, false, v_link.status;
    return;
  end if;

  if v_link.status = 'failed' and v_link.display_serial is not null then
    update public.links
    set status = 'pending',
        last_error = null
    where id = v_link.id
    returning * into v_link;

    update public.link_occurrences
    set outcome = 'claimed'
    where event_fingerprint = v_fingerprint;

    return query select v_link.id, v_link.display_serial, true, v_link.status;
    return;
  end if;

  update public.system_counters
  set counter_value = counter_value + 1
  where counter_key = 'link_display_serial'
  returning counter_value into v_serial;

  if v_serial is null then
    raise exception 'link_display_serial counter is missing';
  end if;

  update public.links
  set display_serial = v_serial,
      status = 'pending',
      discovered_by_session = p_session_id,
      source_group_jid = p_source_group_jid,
      source_group_name = p_source_group_name,
      last_error = null
  where id = v_link.id
  returning * into v_link;

  update public.link_occurrences
  set outcome = 'claimed'
  where event_fingerprint = v_fingerprint;

  return query select v_link.id, v_link.display_serial, true, v_link.status;
end;
$$;

create or replace function public.mark_link_sent(
  p_link_id uuid,
  p_whatsapp_message_id text,
  p_sent_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.links
  set status = 'sent',
      first_sent_at = coalesce(first_sent_at, p_sent_at),
      last_sent_at = p_sent_at,
      last_whatsapp_message_id = p_whatsapp_message_id,
      last_error = null
  where id = p_link_id;

  if not found then raise exception 'Unknown link id: %', p_link_id; end if;
end;
$$;

create or replace function public.mark_link_failed(
  p_link_id uuid,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.links
  set status = 'failed',
      last_error = left(p_error, 2000)
  where id = p_link_id;

  if not found then raise exception 'Unknown link id: %', p_link_id; end if;
end;
$$;

alter table public.system_counters enable row level security;
alter table public.links enable row level security;
alter table public.link_occurrences enable row level security;

revoke all on public.system_counters from anon, authenticated;
revoke all on public.links from anon, authenticated;
revoke all on public.link_occurrences from anon, authenticated;
revoke execute on function public.claim_link_for_sending(text, text, text, text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.mark_link_sent(uuid, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.mark_link_failed(uuid, text) from public, anon, authenticated;

grant usage on schema public to service_role;
grant all on public.system_counters to service_role;
grant all on public.links to service_role;
grant all on public.link_occurrences to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on function public.claim_link_for_sending(text, text, text, text, text, text, text, text, text, timestamptz) to service_role;
grant execute on function public.mark_link_sent(uuid, text, timestamptz) to service_role;
grant execute on function public.mark_link_failed(uuid, text) to service_role;

commit;
