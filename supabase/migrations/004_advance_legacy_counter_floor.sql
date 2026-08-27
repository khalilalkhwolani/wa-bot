-- The legacy Render bot reached serial 1365 after the original recovery export.
-- Move the counter forward only; never lower or reset an existing value.
update public.system_counters
set counter_value = greatest(counter_value, 1365),
    updated_at = now()
where counter_key = 'link_display_serial';

do $$
begin
  if not exists (
    select 1
    from public.system_counters
    where counter_key = 'link_display_serial'
      and counter_value >= 1365
  ) then
    raise exception 'link_display_serial counter floor was not applied';
  end if;
end;
$$;
