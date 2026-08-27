begin;

do $$
declare
  v_id uuid;
  v_serial bigint;
  v_should_send boolean;
  v_status text;
begin
  select link_id, display_serial, should_send, current_status
  into v_id, v_serial, v_should_send, v_status
  from public.claim_link_for_sending(
    'group:codexstagingverification0001',
    'group',
    'CodexStagingVerification0001',
    'https://chat.whatsapp.com/CodexStagingVerification0001',
    'verification_account_2',
    'verification@g.us',
    'staging verification',
    'verification-message-1',
    'verification-sender'
  );

  if not v_should_send or v_serial <> 1157 or v_status <> 'pending' then
    raise exception 'First claim failed: serial %, should_send %, status %', v_serial, v_should_send, v_status;
  end if;

  select link_id, display_serial, should_send, current_status
  into v_id, v_serial, v_should_send, v_status
  from public.claim_link_for_sending(
    'group:codexstagingverification0001',
    'group',
    'CodexStagingVerification0001',
    'https://chat.whatsapp.com/CodexStagingVerification0001',
    'verification_account_3',
    'verification-2@g.us',
    'staging verification duplicate',
    'verification-message-2',
    'verification-sender'
  );

  if v_should_send or v_serial <> 1157 or v_status <> 'pending' then
    raise exception 'Duplicate claim was not suppressed: serial %, should_send %, status %', v_serial, v_should_send, v_status;
  end if;

  perform public.mark_link_failed(v_id, 'verification failure');

  select link_id, display_serial, should_send, current_status
  into v_id, v_serial, v_should_send, v_status
  from public.claim_link_for_sending(
    'group:codexstagingverification0001',
    'group',
    'CodexStagingVerification0001',
    'https://chat.whatsapp.com/CodexStagingVerification0001',
    'verification_account_1',
    'verification@g.us',
    'staging verification retry',
    'verification-message-3',
    'verification-sender'
  );

  if not v_should_send or v_serial <> 1157 or v_status <> 'pending' then
    raise exception 'Retry did not reuse its serial: serial %, should_send %, status %', v_serial, v_should_send, v_status;
  end if;
end;
$$;

rollback;

-- This verification deliberately rolls back, leaving no test link or counter change.
