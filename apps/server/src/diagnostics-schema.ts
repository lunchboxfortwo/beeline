/** Additive diagnostic storage. Identity erasure cascades through claimed sessions. */
export const DIAGNOSTICS_SCHEMA = `
CREATE TABLE IF NOT EXISTS diagnostic_devices (
  id uuid PRIMARY KEY, first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS diagnostic_sessions (
  id uuid PRIMARY KEY, device_id uuid NOT NULL REFERENCES diagnostic_devices(id) ON DELETE CASCADE,
  view_id uuid NOT NULL, binding_hash text NOT NULL,
  user_id text REFERENCES identities(id) ON DELETE CASCADE,
  auth_family_id text, descriptor jsonb NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS diagnostic_sessions_device ON diagnostic_sessions(device_id);
CREATE INDEX IF NOT EXISTS diagnostic_sessions_user ON diagnostic_sessions(user_id,last_seen);
-- This global key survives a retry crossing a date partition boundary.
CREATE TABLE IF NOT EXISTS diagnostic_event_keys (
  event_id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES diagnostic_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS diagnostic_keys_session ON diagnostic_event_keys(session_id);
CREATE TABLE IF NOT EXISTS diagnostic_actions (
  event_id uuid NOT NULL, session_id uuid REFERENCES diagnostic_sessions(id) ON DELETE CASCADE,
  user_id text REFERENCES identities(id) ON DELETE CASCADE,
  source text NOT NULL CHECK(source IN ('client','server','agent')),
  received_at timestamptz NOT NULL DEFAULT now(), occurred_at timestamptz NOT NULL,
  sequence bigint, action_id uuid, command_id text, detail jsonb NOT NULL
) PARTITION BY RANGE(received_at);
CREATE TABLE IF NOT EXISTS diagnostic_actions_default PARTITION OF diagnostic_actions DEFAULT;
CREATE INDEX IF NOT EXISTS diagnostic_actions_session ON diagnostic_actions_default(session_id,sequence);
CREATE INDEX IF NOT EXISTS diagnostic_actions_user ON diagnostic_actions_default(user_id,received_at);
CREATE INDEX IF NOT EXISTS diagnostic_actions_action ON diagnostic_actions_default(action_id);
CREATE INDEX IF NOT EXISTS diagnostic_actions_command ON diagnostic_actions_default(command_id);
CREATE TABLE IF NOT EXISTS workspace_creation_facts (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  source text NOT NULL CHECK(source IN ('manual_ui','onboarding','mcp_consent','recovery')),
  action_id uuid, session_id uuid, device_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_creation_facts_user ON workspace_creation_facts(user_id,created_at);
CREATE TABLE IF NOT EXISTS diagnostic_reads (
  id bigserial PRIMARY KEY, user_id text REFERENCES identities(id) ON DELETE CASCADE,
  authority text NOT NULL, read_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS diagnostic_reads_user ON diagnostic_reads(user_id);
CREATE TABLE IF NOT EXISTS diagnostic_command_origins (
  command_id text PRIMARY KEY, session_id uuid REFERENCES diagnostic_sessions(id) ON DELETE CASCADE,
  user_id text REFERENCES identities(id) ON DELETE CASCADE, action_id uuid
);
CREATE INDEX IF NOT EXISTS diagnostic_command_origins_session ON diagnostic_command_origins(session_id);
CREATE INDEX IF NOT EXISTS diagnostic_command_origins_user ON diagnostic_command_origins(user_id);
`;

/** Observes committed work transitions; never claims, wakes or completes work. */
export const DIAGNOSTIC_COMMAND_SCHEMA = `
CREATE OR REPLACE FUNCTION record_diagnostic_command_state() RETURNS trigger AS $$
BEGIN
  IF OLD.state IS DISTINCT FROM NEW.state THEN
    INSERT INTO diagnostic_actions(event_id,session_id,user_id,source,occurred_at,action_id,command_id,detail)
    SELECT gen_random_uuid(),origin.session_id,COALESCE(origin.user_id,agent.owner_id),'agent',now(),origin.action_id,NEW.id,
      jsonb_build_object('name',CASE WHEN NEW.state IN ('complete','cancelled') THEN 'agent_terminal' ELSE 'agent_command' END,
        'outcome',CASE WHEN NEW.state='cancelled' THEN 'cancelled' WHEN turn.status='failed' THEN 'failed'
          WHEN NEW.state='claimed' THEN 'started' WHEN turn.completion_kind='no-reply' OR NEW.result_message_id IS NOT NULL THEN 'success' ELSE 'unknown' END,
        'hostResult',CASE WHEN turn.completion_kind='no-reply' THEN 'no_reply' WHEN turn.status='failed' THEN 'failed'
          WHEN NEW.result_message_id IS NOT NULL THEN 'reply_recorded' ELSE 'unknown' END,
        'commandState',NEW.state,'terminalReason',CASE WHEN NEW.state IN ('complete','cancelled') THEN 'recorded' ELSE NULL END,
        'generationId',NEW.generation_id)
    FROM agents agent LEFT JOIN diagnostic_command_origins origin ON origin.command_id=NEW.id
    LEFT JOIN agent_turns turn ON turn.room_id=NEW.room_id AND turn.request_id=NEW.turn_request_id AND turn.agent_id=NEW.agent_id
    WHERE agent.agent_id=NEW.agent_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS diagnostic_command_state ON agent_commands;
CREATE CONSTRAINT TRIGGER diagnostic_command_state AFTER UPDATE ON agent_commands DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION record_diagnostic_command_state();
`;
