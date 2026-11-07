export const MCP_DELIVERY_OWNER_SCHEMA = `
CREATE OR REPLACE FUNCTION beeline_mcp_delivery_owner(member text, route text, subscription text DEFAULT NULL)
RETURNS boolean AS $$
 SELECT CASE WHEN d.member_id IS NOT NULL THEN
   d.mechanism=route AND (route<>'events' OR subscription=d.subscription_id OR EXISTS(
     SELECT 1 FROM rooms_mcp_event_subscriptions selected JOIN rooms_mcp_event_subscriptions candidate
       ON candidate.id=subscription AND candidate.member_id=selected.member_id AND candidate.url=selected.url
     WHERE selected.id=d.subscription_id))
 ELSE CASE WHEN NULLIF(COALESCE(m.callback_url,c.callback_url),'') IS NOT NULL THEN route='webhook'
   WHEN EXISTS(SELECT 1 FROM rooms_mcp_event_subscriptions s WHERE s.member_id=member AND (s.expires_at IS NULL OR s.expires_at>now()))
   THEN route='events' AND (SELECT candidate.url FROM rooms_mcp_event_subscriptions candidate WHERE candidate.id=subscription)=(SELECT s.url FROM rooms_mcp_event_subscriptions s
     WHERE s.member_id=member AND (s.expires_at IS NULL OR s.expires_at>now()) ORDER BY (s.event_name='mention') DESC,s.verified_at DESC,s.id LIMIT 1)
   ELSE route='local' END END
 FROM rooms_mcp_members m JOIN rooms_mcp_clients c ON c.id=m.client_id
 LEFT JOIN rooms_mcp_delivery d ON d.member_id=m.member_id WHERE m.member_id=member
$$ LANGUAGE sql STABLE;
`;

/** One selected delivery owner per consented member. Receipts never authorize work. */
export const MCP_DELIVERY_SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms_mcp_delivery (
  member_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  generation text NOT NULL, mechanism text NOT NULL CHECK(mechanism IN ('local','events','webhook','on_demand')),
  host text NOT NULL, surface text NOT NULL, conversation text NOT NULL,
  nonce_hash text NOT NULL, probe jsonb NOT NULL, subscription_id text,
  credential_hash text REFERENCES rooms_mcp_tokens(hash) ON DELETE SET NULL,
  receipt_at timestamptz, failure text, stream_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rooms_mcp_delivery_attachments (
  hash text PRIMARY KEY, client_id text NOT NULL, owner_id text NOT NULL,
  member_id text NOT NULL UNIQUE REFERENCES identities(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, consumed_at timestamptz
);
${MCP_DELIVERY_OWNER_SCHEMA}
ALTER TABLE rooms_mcp_event_deliveries ADD COLUMN IF NOT EXISTS probe_generation text;
ALTER TABLE rooms_mcp_event_deliveries DROP CONSTRAINT IF EXISTS rooms_mcp_event_deliveries_subject;
ALTER TABLE rooms_mcp_event_deliveries ADD CONSTRAINT rooms_mcp_event_deliveries_subject
 CHECK(num_nonnulls(message_id,command_id,probe_generation)=1);
`;
