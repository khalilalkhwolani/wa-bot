begin;

-- بيانات تحقق ثابتة. إعادة تشغيل التحقق لا تولّد رقماً جديداً ولا تحذف شيئاً.
select * from public.claim_student_lead(
  'verification-student-lead-source-0001',
  'verification-student-lead-content-0001',
  'verification-message-0001',
  'verification-group@g.us',
  'verification-sender@s.whatsapp.net',
  'verification_account_2',
  null,
  '966000000000',
  'طالب تحقق',
  'أحتاج مساعدة في واجب رياضيات',
  null,
  'ASK_HELP',
  'رياضيات',
  0.95,
  90,
  'staging verification',
  'accepted',
  12,
  now()
);

do $$
declare
  v_first public.student_leads%rowtype;
  v_second_should_deliver boolean;
  v_review_status text;
begin
  select * into v_first
  from public.student_leads
  where source_fingerprint = 'verification-student-lead-source-0001';

  if v_first.id is null or v_first.display_serial is null or v_first.status not in ('pending', 'sent') then
    raise exception 'Student lead accepted-claim verification failed';
  end if;

  select should_deliver into v_second_should_deliver
  from public.claim_student_lead(
    'verification-student-lead-source-0001',
    'verification-student-lead-content-0001',
    'verification-message-0001',
    'verification-group@g.us',
    'verification-sender@s.whatsapp.net',
    'verification_account_3',
    null, '966000000000', 'طالب تحقق', 'أحتاج مساعدة في واجب رياضيات', null,
    'ASK_HELP', 'رياضيات', 0.95, 90, 'duplicate verification', 'accepted', 12, now()
  );
  if v_second_should_deliver then raise exception 'Duplicate student lead unexpectedly deliverable'; end if;

  select current_status into v_review_status
  from public.claim_student_lead(
    'verification-student-lead-review-source-0001',
    'verification-student-lead-review-content-0001',
    'verification-review-message-0001',
    'verification-group@g.us',
    'verification-reviewer@s.whatsapp.net',
    'verification_account_2',
    null, '966000000001', 'طالب مراجعة', 'رسالة غير واضحة', null,
    'UNKNOWN', null, 0, 0, 'AI unavailable verification', 'review', 12, now()
  );
  if v_review_status <> 'review' then raise exception 'Review student lead was not retained as review'; end if;
end;
$$;

rollback;
