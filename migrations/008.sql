-- Preserve inferred provenance and all existing evidence; no owner assertion is manufactured.
UPDATE memories SET status='stored' WHERE status='candidate';
-- memory_confirmations remains read-only legacy lineage for source reading and erasure.
