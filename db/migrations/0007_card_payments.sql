-- A payment taken by a card provider carries the provider's own id, so the same notification arriving twice
-- (providers retry) can never record the money twice.
ALTER TABLE payments ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX payments_external_once ON payments (clinic_id, external_id) WHERE external_id IS NOT NULL;
