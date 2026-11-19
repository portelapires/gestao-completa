-- Endurecimento compatível com o cadastro automático existente.
-- Não altera políticas RLS, preços, prazos, dados ou gatilhos.

DO $check$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job
    WHERE command ILIKE '%process_subscription_lifecycle%'
      AND username NOT IN ('postgres', 'service_role')
  ) THEN
    RAISE EXCEPTION 'Rotina agendada com executor diferente do esperado. Revisar antes de alterar permissoes.';
  END IF;
END
$check$;

ALTER FUNCTION public.handle_new_user() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.handle_new_user_subscription() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.process_subscription_lifecycle() SET search_path = pg_catalog, pg_temp;

REVOKE EXECUTE ON FUNCTION public.handle_new_user(), public.handle_new_user_subscription(), public.process_subscription_lifecycle() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user(), public.handle_new_user_subscription(), public.process_subscription_lifecycle() TO postgres, service_role;

REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.profiles, public.contas, public.veiculos, public.pagamentos_mensais, public.assinaturas FROM PUBLIC, anon, authenticated;

DO $verify$
DECLARE
  r text;
  t text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(r, 'public.process_subscription_lifecycle()', 'EXECUTE') THEN
      RAISE EXCEPTION 'Permissao administrativa ainda herdada pelo papel %; transacao cancelada.', r;
    END IF;

    FOREACH t IN ARRAY ARRAY['profiles', 'contas', 'veiculos', 'pagamentos_mensais', 'assinaturas'] LOOP
      IF has_table_privilege(r, format('public.%I', t), 'TRUNCATE') THEN
        RAISE EXCEPTION 'TRUNCATE ainda herdado em % pelo papel %; transacao cancelada.', t, r;
      END IF;
    END LOOP;
  END LOOP;
END
$verify$;