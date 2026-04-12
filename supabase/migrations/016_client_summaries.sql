-- Accountant summary notes for clients
-- Generated on-demand via Claude Sonnet; refreshable; downloadable
CREATE TABLE IF NOT EXISTS client_summaries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL,
  period_from   date,
  period_to     date,
  summary_md    text NOT NULL,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  generated_by  uuid REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS client_summaries_client_id_idx ON client_summaries(client_id, generated_at DESC);

ALTER TABLE client_summaries ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_summaries_tenant ON client_summaries
  USING (tenant_id = (SELECT tenant_id FROM users WHERE id = auth.uid()));
