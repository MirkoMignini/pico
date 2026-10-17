-- Distinguish evidence a run used directly from sources inherited through prior
-- conversation context. Only direct rows make an authored note depend on a source.
ALTER TABLE run_sources ADD COLUMN inherited INTEGER NOT NULL DEFAULT 0;
