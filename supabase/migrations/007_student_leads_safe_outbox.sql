begin;

-- سجل طلبات الطلاب مستقل عن الروابط. لا يحذف أو يغير أي سجل روابط قائم.
insert into public.system_counters (counter_key, counter_value)
values ('student_lead_display_serial', 0)
on conflict (counter_key) do nothing;

create table if not exists public.student_leads (
  id uuid primary key default gen_random_uuid(),
  source_fingerprint text not null unique,
  content_fingerprint text not null,
  source_message_id text,
  source_chat_jid text,
  source_sender_jid text,
  source_session_id text,
  source_group_invite_url text,
  student_phone text,
  student_name text,
  message_content text not null,
  quoted_content text,
  classification text not null,
  subject text,
  confidence numeric(5,4),
  score integer,
  decision_reason text,
  status text not null default 'review'
    check (status in ('review', 'rejected', 'pending', 'sent', 'failed')),
  display_serial bigint unique,
  whatsapp_message_id text,
  delivery_attempts integer not null default 0 check (delivery_attempts >= 0),
  last_error text,
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists student_leads_status_idx on public.student_leads (status, created_at desc);
create index if not exists student_leads_content_dedup_idx on public.student_leads (source_sender_jid, content_fingerprint, last_observed_at desc);

create table if not exists public.student_lead_occurrences (
  id bigint generated always as identity primary key,
  lead_id uuid not null references public.student_leads(id) on delete restrict,
  source_fingerprint text not null unique,
  observed_at timestamptz not null default now(),
  session_id text,
  source_message_id text,
  source_chat_jid text,
  source_sender_jid text,
  outcome text not null check (outcome in ('accepted', 'review', 'rejected', 'duplicate')),
  created_at timestamptz not null default now()
);

create index if not exists student_lead_occurrences_lead_idx on public.student_lead_occurrences (lead_id, observed_at desc);

drop trigger if exists student_leads_touch_updated_at on public.student_leads;
create trigger student_leads_touch_updated_at
before update on public.student_leads
for each row execute function public.touch_updated_at();

create or replace function public.claim_student_lead(
  p_source_fingerprint text,
  p_content_fingerprint text,
  p_source_message_id text,
  p_source_chat_jid text,
  p_source_sender_jid text,
  p_source_session_id text,
  p_source_group_invite_url text,
  p_student_phone text,
  p_student_name text,
  p_message_content text,
  p_quoted_content text,
  p_classification text,
  p_subject text,
  p_confidence numeric,
  p_score integer,
  p_decision_reason text,
  p_decision text,
  p_dedup_window_hours integer default 12,
  p_observed_at timestamptz default now()
)
returns table (
  lead_id uuid,
  display_serial bigint,
  should_deliver boolean,
  current_status text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_existing public.student_leads%rowtype;
  v_lead public.student_leads%rowtype;
  v_serial bigint;
  v_outcome text;
begin
  if p_decision not in ('accepted', 'review', 'rejected') then
    raise exception 'Unsupported student lead decision: %', p_decision;
  end if;

  -- يقفل المفتاح أثناء العملية، فتصل الرسالة نفسها من عدة حسابات بلا سباق أو تكرار.
  perform pg_advisory_xact_lock(hashtext(coalesce(p_source_sender_jid, '') || '|' || p_content_fingerprint));

  select * into v_existing
  from public.student_leads
  where source_fingerprint = p_source_fingerprint
  for update;

  if found then
    update public.student_leads
    set last_observed_at = greatest(last_observed_at, p_observed_at)
    where id = v_existing.id
    returning * into v_lead;

    insert into public.student_lead_occurrences (
      lead_id, source_fingerprint, observed_at, session_id, source_message_id,
      source_chat_jid, source_sender_jid, outcome
    ) values (
      v_lead.id, p_source_fingerprint, p_observed_at, p_source_session_id, p_source_message_id,
      p_source_chat_jid, p_source_sender_jid, 'duplicate'
    ) on conflict (source_fingerprint) do nothing;

    return query select v_lead.id, v_lead.display_serial, false, v_lead.status;
    return;
  end if;

  -- يمنع نص الطلب نفسه من الشخص نفسه خلال النافذة، لكن لا يمنع طلباً جديداً بعد انتهائها.
  select * into v_existing
  from public.student_leads
  where source_sender_jid is not distinct from p_source_sender_jid
    and content_fingerprint = p_content_fingerprint
    and last_observed_at >= p_observed_at - make_interval(hours => greatest(1, p_dedup_window_hours))
  order by last_observed_at desc
  limit 1
  for update;

  if found then
    update public.student_leads
    set last_observed_at = greatest(last_observed_at, p_observed_at)
    where id = v_existing.id
    returning * into v_lead;

    insert into public.student_lead_occurrences (
      lead_id, source_fingerprint, observed_at, session_id, source_message_id,
      source_chat_jid, source_sender_jid, outcome
    ) values (
      v_lead.id, p_source_fingerprint, p_observed_at, p_source_session_id, p_source_message_id,
      p_source_chat_jid, p_source_sender_jid, 'duplicate'
    ) on conflict (source_fingerprint) do nothing;

    return query select v_lead.id, v_lead.display_serial, false, v_lead.status;
    return;
  end if;

  if p_decision = 'accepted' then
    update public.system_counters
    set counter_value = counter_value + 1
    where counter_key = 'student_lead_display_serial'
    returning counter_value into v_serial;
    if v_serial is null then raise exception 'student_lead_display_serial counter is missing'; end if;
  end if;

  insert into public.student_leads (
    source_fingerprint, content_fingerprint, source_message_id, source_chat_jid,
    source_sender_jid, source_session_id, source_group_invite_url, student_phone,
    student_name, message_content, quoted_content, classification, subject,
    confidence, score, decision_reason, status, display_serial, first_observed_at, last_observed_at
  ) values (
    p_source_fingerprint, p_content_fingerprint, p_source_message_id, p_source_chat_jid,
    p_source_sender_jid, p_source_session_id, p_source_group_invite_url, p_student_phone,
    p_student_name, p_message_content, p_quoted_content, p_classification, p_subject,
    p_confidence, p_score, p_decision_reason,
    case p_decision when 'accepted' then 'pending' when 'review' then 'review' else 'rejected' end,
    v_serial, p_observed_at, p_observed_at
  ) returning * into v_lead;

  v_outcome := case p_decision when 'accepted' then 'accepted' when 'review' then 'review' else 'rejected' end;
  insert into public.student_lead_occurrences (
    lead_id, source_fingerprint, observed_at, session_id, source_message_id,
    source_chat_jid, source_sender_jid, outcome
  ) values (
    v_lead.id, p_source_fingerprint, p_observed_at, p_source_session_id, p_source_message_id,
    p_source_chat_jid, p_source_sender_jid, v_outcome
  );

  return query select v_lead.id, v_lead.display_serial, p_decision = 'accepted', v_lead.status;
end;
$$;

create or replace function public.mark_student_lead_sent(
  p_lead_id uuid,
  p_whatsapp_message_id text,
  p_sent_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.student_leads
  set status = 'sent', whatsapp_message_id = p_whatsapp_message_id, sent_at = p_sent_at,
      delivery_attempts = delivery_attempts + 1, last_error = null
  where id = p_lead_id and status = 'pending';
  if not found then raise exception 'Student lead is not pending: %', p_lead_id; end if;
end;
$$;

create or replace function public.mark_student_lead_failed(
  p_lead_id uuid,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.student_leads
  set status = 'failed', delivery_attempts = delivery_attempts + 1, last_error = left(p_error, 2000)
  where id = p_lead_id and status = 'pending';
  if not found then raise exception 'Student lead is not pending: %', p_lead_id; end if;
end;
$$;

alter table public.student_leads enable row level security;
alter table public.student_lead_occurrences enable row level security;
revoke all on public.student_leads from anon, authenticated;
revoke all on public.student_lead_occurrences from anon, authenticated;
revoke execute on function public.claim_student_lead(text, text, text, text, text, text, text, text, text, text, text, text, text, numeric, integer, text, text, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.mark_student_lead_sent(uuid, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.mark_student_lead_failed(uuid, text) from public, anon, authenticated;
grant all on public.student_leads to service_role;
grant all on public.student_lead_occurrences to service_role;
grant execute on function public.claim_student_lead(text, text, text, text, text, text, text, text, text, text, text, text, text, numeric, integer, text, text, integer, timestamptz) to service_role;
grant execute on function public.mark_student_lead_sent(uuid, text, timestamptz) to service_role;
grant execute on function public.mark_student_lead_failed(uuid, text) to service_role;

commit;
