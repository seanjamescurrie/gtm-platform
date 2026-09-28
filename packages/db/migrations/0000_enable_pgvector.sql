-- Custom migration: enable pgvector here, not in a Docker init script, so RDS gets it too.
CREATE EXTENSION IF NOT EXISTS vector;
