BEGIN;

-- Controle persistente de concorrencia; nao altera gatilhos nem RLS existentes.
CREATE TABLE public.a19_checkout_guard (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  token uuid NOT NULL UNIQUE,
  operation text NOT NULL CHECK (operation IN ('subscribe', 'cancel')),
  state text NOT NULL CHECK (state IN ('working', 'uncertain')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.a19_checkout_guard ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.a19_checkout_guard FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.a19_checkout_guard TO service_role;
COMMENT ON TABLE public.a19_checkout_guard IS 'Nao expirar nem remover tentativas pendentes sem conciliar no Asaas a referencia gc:<token>. Exclusao manual sem conciliacao pode permitir duplicidades.';

COMMIT;
