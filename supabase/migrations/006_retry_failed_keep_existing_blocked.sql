begin;

-- Existing links must not be resent, except a real send failure.
-- failed + display_serial: retry the same number (never create a new serial).
-- sent / historically_sent / observed_unconfirmed / pending: never send again.
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
  v_key text := lower(p_canonical_key);
  v_link public.links%rowtype;
  v_serial bigint;
  v_fingerprint text;
  v_outcome text;
  v_should_send boolean;
begin
  if p_link_type not in ('group', 'channel') then
    raise exception 'Unsupported link type: %', p_link_type;
  end if;

  perform pg_advisory_xact_lock(hashtext(v_key));

  v_fingerprint := encode(
    digest(
      concat_ws('|', v_key, coalesce(p_session_id, ''), coalesce(p_source_message_id, '')),
      'sha256'
    ),
    'hex'
  );

  select *
  into v_link
  from public.links
  where canonical_key = v_key
  for update;

  if found then
    v_should_send := (v_link.status = 'failed' and v_link.display_serial is not null);
    v_outcome := case when v_should_send then 'claimed' else 'duplicate' end;

    if v_should_send then
      update public.links
      set occurrence_count = public.links.occurrence_count + 1,
          last_observed_at = greatest(public.links.last_observed_at, p_observed_at),
          url = p_url,
          status = 'pending',
          last_error = null
      where id = v_link.id
      returning * into v_link;
    else
      update public.links
      set occurrence_count = public.links.occurrence_count + 1,
          last_observed_at = greatest(public.links.last_observed_at, p_observed_at),
          url = p_url
      where id = v_link.id
      returning * into v_link;
    end if;

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
      v_outcome
    )
    on conflict (event_fingerprint) do nothing;

    return query select v_link.id, v_link.display_serial, v_should_send, v_link.status;
    return;
  end if;

  update public.system_counters
  set counter_value = counter_value + 1
  where counter_key = 'link_display_serial'
  returning counter_value into v_serial;

  if v_serial is null then
    raise exception 'link_display_serial counter is missing';
  end if;

  insert into public.links (
    canonical_key,
    link_type,
    invite_code,
    url,
    status,
    display_serial,
    first_observed_at,
    last_observed_at,
    discovered_by_session,
    source_group_jid,
    source_group_name
  ) values (
    v_key,
    p_link_type,
    p_invite_code,
    p_url,
    'pending',
    v_serial,
    p_observed_at,
    p_observed_at,
    p_session_id,
    p_source_group_jid,
    p_source_group_name
  )
  returning * into v_link;

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
    'claimed'
  )
  on conflict (event_fingerprint) do nothing;

  return query select v_link.id, v_link.display_serial, true, v_link.status;
end;
$$;

revoke execute on function public.claim_link_for_sending(text, text, text, text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_link_for_sending(text, text, text, text, text, text, text, text, text, timestamptz) to service_role;

commit;
