export const HELPER_READ_SCHEMA = `
CREATE TABLE IF NOT EXISTS helper_read_windows (
  agent_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  reads integer NOT NULL
)
`;
