-- Migration 018: Remove duplicate reconciliation rows per bank_transaction_id
-- Keeps the row with the highest-priority status (matched > possible_match > others)
-- and the most recent matched_at. Runs safely even if no duplicates exist.

DELETE FROM reconciliations
WHERE id IN (
  SELECT id FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY tenant_id, bank_transaction_id
        ORDER BY
          CASE status
            WHEN 'matched'       THEN 1
            WHEN 'manual_match'  THEN 1
            WHEN 'possible_match' THEN 2
            ELSE 3
          END ASC,
          matched_at DESC
      ) AS rn
    FROM reconciliations
    WHERE status != 'exception'
  ) ranked
  WHERE rn > 1
);
