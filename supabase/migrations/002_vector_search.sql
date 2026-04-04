-- Migration 002: Vector similarity search function
-- Used by extract-document Edge Function to retrieve similar past corrections
-- for few-shot injection into the Claude prompt

CREATE OR REPLACE FUNCTION match_correction_vectors(
  query_embedding vector(384),
  match_tenant_id uuid,
  match_count     int DEFAULT 5
)
RETURNS TABLE (
  id                   uuid,
  correction_record_id uuid,
  doc_fingerprint      text,
  similarity           float
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    cv.id,
    cv.correction_record_id,
    cv.doc_fingerprint,
    1 - (cv.correction_embedding <=> query_embedding) AS similarity
  FROM correction_vectors cv
  WHERE cv.tenant_id = match_tenant_id
  ORDER BY cv.correction_embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
