-- 0003: race-free credit debit and refund (P1.8). Runs as ledgerline_owner.
--
-- The ledger stays append-only: a refund is a new row that points at the debit it reverses.
-- The functions are SECURITY INVOKER on purpose: they run as the application role, inside the
-- caller's tenant transaction, so forced RLS and the ordinary grants still apply. The tenant is
-- never a parameter; it is always app_tenant_id().

-- What a ledger row recorded, so a replayed idempotency key can return the original result.
ALTER TABLE credit_ledger ADD COLUMN balance_after bigint;
ALTER TABLE credit_ledger ADD COLUMN refund_of bigint;

-- A refund must point at a ledger row of the SAME tenant (otherwise one tenant could "refund"
-- another tenant's debit and block it), so the foreign key is composite.
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_refund_of_fkey
  FOREIGN KEY (tenant_id, refund_of) REFERENCES credit_ledger (tenant_id, id);
-- Only refund rows carry refund_of, and amounts have the right sign for their kind.
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_refund_of_kind
  CHECK (refund_of IS NULL OR kind = 'refund');
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_amount_sign
  CHECK ((kind = 'debit' AND amount < 0)
      OR (kind IN ('grant', 'refund') AND amount > 0)
      OR kind = 'adjustment');
-- One refund per debit (the database-level backstop for the function's own check).
CREATE UNIQUE INDEX credit_ledger_refund_of_key ON credit_ledger (refund_of) WHERE refund_of IS NOT NULL;

-- debit_credits: spend p_amount credits for the current tenant.
--   outcome 'debited'              ledger row appended, balance reduced
--   outcome 'insufficient_credits' nothing written (balance returned is the balance seen)
--   outcome 'idempotency_conflict' p_key was already used for something different; nothing written
--   replayed = true when the same key and amount had already been applied: the ORIGINAL ledger id
--   and balance_after are returned and nothing is written again.
-- Rejections are not recorded, so a retry of a rejected key is evaluated afresh.
CREATE FUNCTION ledgerline_fn.debit_credits(p_amount bigint, p_key text, p_reference text DEFAULT NULL)
RETURNS TABLE (outcome text, ledger_id bigint, balance bigint, replayed boolean)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.app_tenant_id();
  v_balance bigint;
  v_prev public.credit_ledger%ROWTYPE;
  v_id bigint;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant set for this transaction' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be positive' USING ERRCODE = '22023';
  END IF;
  IF p_key IS NULL OR p_key = '' THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '22023';
  END IF;

  -- The row lock serialises every debit and refund of this tenant.
  SELECT b.balance INTO v_balance
  FROM public.credit_balances b WHERE b.tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant has no credit balance row' USING ERRCODE = 'P0002';
  END IF;

  -- Looked up only after the lock is held, so concurrent requests with the same key queue up
  -- behind the first one and then see its committed row.
  SELECT * INTO v_prev FROM public.credit_ledger l
  WHERE l.tenant_id = v_tenant AND l.idempotency_key = p_key;
  IF FOUND THEN
    IF v_prev.kind = 'debit' AND v_prev.amount = -p_amount THEN
      RETURN QUERY SELECT 'debited'::text, v_prev.id, v_prev.balance_after, true;
    ELSE
      RETURN QUERY SELECT 'idempotency_conflict'::text, v_prev.id, v_balance, false;
    END IF;
    RETURN;
  END IF;

  IF v_balance < p_amount THEN
    RETURN QUERY SELECT 'insufficient_credits'::text, NULL::bigint, v_balance, false;
    RETURN;
  END IF;

  INSERT INTO public.credit_ledger (tenant_id, amount, kind, idempotency_key, reference, balance_after)
  VALUES (v_tenant, -p_amount, 'debit', p_key, p_reference, v_balance - p_amount)
  RETURNING id INTO v_id;
  UPDATE public.credit_balances b
  SET balance = v_balance - p_amount, updated_at = now() WHERE b.tenant_id = v_tenant;
  RETURN QUERY SELECT 'debited'::text, v_id, v_balance - p_amount, false;
END $$;

-- refund_credits: give back credits for one earlier debit of the current tenant.
-- A debit can be refunded ONCE, for any amount from 1 up to the debit amount (no repeated
-- partial refunds). outcomes: 'refunded', 'debit_not_found', 'refund_exceeds_debit',
-- 'already_refunded', 'idempotency_conflict'; replayed = true for a repeated identical request.
CREATE FUNCTION ledgerline_fn.refund_credits(
  p_debit_id bigint, p_amount bigint, p_key text, p_reference text DEFAULT NULL)
RETURNS TABLE (outcome text, ledger_id bigint, balance bigint, replayed boolean)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := public.app_tenant_id();
  v_balance bigint;
  v_prev public.credit_ledger%ROWTYPE;
  v_debit public.credit_ledger%ROWTYPE;
  v_id bigint;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant set for this transaction' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be positive' USING ERRCODE = '22023';
  END IF;
  IF p_key IS NULL OR p_key = '' THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = '22023';
  END IF;

  SELECT b.balance INTO v_balance
  FROM public.credit_balances b WHERE b.tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant has no credit balance row' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_prev FROM public.credit_ledger l
  WHERE l.tenant_id = v_tenant AND l.idempotency_key = p_key;
  IF FOUND THEN
    IF v_prev.kind = 'refund' AND v_prev.refund_of = p_debit_id AND v_prev.amount = p_amount THEN
      RETURN QUERY SELECT 'refunded'::text, v_prev.id, v_prev.balance_after, true;
    ELSE
      RETURN QUERY SELECT 'idempotency_conflict'::text, v_prev.id, v_balance, false;
    END IF;
    RETURN;
  END IF;

  SELECT * INTO v_debit FROM public.credit_ledger l
  WHERE l.id = p_debit_id AND l.tenant_id = v_tenant AND l.kind = 'debit';
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'debit_not_found'::text, NULL::bigint, v_balance, false;
    RETURN;
  END IF;
  IF p_amount > -v_debit.amount THEN
    RETURN QUERY SELECT 'refund_exceeds_debit'::text, NULL::bigint, v_balance, false;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.credit_ledger l WHERE l.refund_of = p_debit_id) THEN
    RETURN QUERY SELECT 'already_refunded'::text, NULL::bigint, v_balance, false;
    RETURN;
  END IF;

  INSERT INTO public.credit_ledger
    (tenant_id, amount, kind, idempotency_key, reference, refund_of, balance_after)
  VALUES (v_tenant, p_amount, 'refund', p_key, p_reference, p_debit_id, v_balance + p_amount)
  RETURNING id INTO v_id;
  UPDATE public.credit_balances b
  SET balance = v_balance + p_amount, updated_at = now() WHERE b.tenant_id = v_tenant;
  RETURN QUERY SELECT 'refunded'::text, v_id, v_balance + p_amount, false;
END $$;

REVOKE EXECUTE ON FUNCTION ledgerline_fn.debit_credits(bigint, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ledgerline_fn.refund_credits(bigint, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledgerline_fn.debit_credits(bigint, text, text) TO ledgerline_app;
GRANT EXECUTE ON FUNCTION ledgerline_fn.refund_credits(bigint, bigint, text, text) TO ledgerline_app;
