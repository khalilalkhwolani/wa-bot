select
  count(*) filter (where metadata ? 'recoverySourceSha256') as recovered_unique_links,
  count(*) filter (where metadata ? 'recoverySourceSha256' and status = 'historically_sent') as historically_sent,
  count(*) filter (where metadata ? 'recoverySourceSha256' and status = 'observed_unconfirmed') as observed_unconfirmed,
  count(*) filter (where metadata ? 'recoverySourceSha256' and display_serial is not null) as historical_rows_with_live_serial
from public.links;

select count(*) as recovered_occurrences
from public.link_occurrences
where metadata ? 'recoverySourceSha256';

select counter_key, counter_value
from public.system_counters
where counter_key = 'link_display_serial';

select canonical_key, count(*)
from public.links
group by canonical_key
having count(*) > 1;

-- Expected:
-- recovered_unique_links = 5835
-- historically_sent = 4082
-- observed_unconfirmed = 1753
-- historical_rows_with_live_serial = 0
-- recovered_occurrences = 8158
-- link_display_serial counter_value >= 1156
-- duplicate canonical-key query returns zero rows
