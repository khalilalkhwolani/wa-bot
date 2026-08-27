begin;

alter function public.claim_link_for_sending(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  timestamptz
)
set search_path = public, extensions;

commit;
