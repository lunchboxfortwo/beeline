/** Identity handles remain global fallback addresses during serving overlap.
 * Workspace reservations survive departure, renaming and migration replay. */
export const WORKSPACE_HANDLE_SCHEMA = `
ALTER TABLE identities ADD COLUMN IF NOT EXISTS workspace_handle_base text;
CREATE TABLE IF NOT EXISTS workspace_handles (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  handle text NOT NULL,
  PRIMARY KEY(workspace_id,identity_id),
  UNIQUE(workspace_id,handle)
);
CREATE INDEX IF NOT EXISTS workspace_handles_identity ON workspace_handles(identity_id);

-- Old addresses are preserved exactly, including numbered ones. Human handles
-- remain global and are read from identities, so explicit human edits still work.
INSERT INTO workspace_handles(workspace_id,identity_id,handle)
SELECT DISTINCT member.workspace_id,identity.id,identity.handle
FROM memberships member JOIN identities identity ON identity.id=member.identity_id
WHERE identity.kind='agent' AND identity.handle IS NOT NULL
  AND identity.workspace_handle_base IS NULL
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION beeline_workspace_handle(who text,place uuid)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN identity.kind='agent' THEN COALESCE(
    (SELECT handle FROM workspace_handles WHERE workspace_id=place AND identity_id=who),CASE WHEN place IS NULL THEN COALESCE(identity.workspace_handle_base,identity.handle) ELSE identity.handle END)
    ELSE identity.handle END FROM identities identity WHERE identity.id=who;
$$;
CREATE OR REPLACE FUNCTION beeline_room_handle(who text,place uuid)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT beeline_workspace_handle(who,(SELECT workspace_id FROM rooms WHERE id=place));
$$;

CREATE OR REPLACE FUNCTION beeline_reserve_workspace_handle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE preferred text; stem text; candidate text; suffix numeric := 1;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM identities WHERE id=NEW.identity_id AND kind='agent') THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM workspace_handles WHERE workspace_id=NEW.workspace_id AND identity_id=NEW.identity_id) THEN RETURN NEW; END IF;
  -- All arrivals, including DM participants from other workspaces, reserve in
  -- the place's workspace. Serialize first reservations with other arrivals.
  PERFORM id FROM workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM workspace_handles WHERE workspace_id=NEW.workspace_id AND identity_id=NEW.identity_id) THEN RETURN NEW; END IF;
  SELECT COALESCE(workspace_handle_base,handle) INTO preferred
    FROM identities WHERE id=NEW.identity_id FOR UPDATE;
  IF preferred IS NULL THEN RETURN NEW; END IF;
  candidate := preferred;
  stem := regexp_replace(preferred,'_[0-9]+$','');
  IF preferred ~ '_[0-9]+$' THEN suffix := substring(preferred from '([0-9]+)$')::numeric; END IF;
  LOOP
    -- Share the native global counter lock with explicit person claims. Its
    -- latest value also prevents a racing claim from reusing this reservation.
    INSERT INTO identity_handle_counters(name,n)
      VALUES(regexp_replace(candidate,'_[0-9]+$',''),
        CASE WHEN candidate ~ '_[0-9]+$' THEN substring(candidate from '([0-9]+)$')::numeric ELSE 1 END)
      ON CONFLICT(name) DO UPDATE SET n=greatest(identity_handle_counters.n,excluded.n);
    EXIT WHEN candidate NOT IN ('channel','system','review','play-review','scheduler') AND NOT EXISTS(
      SELECT 1 FROM workspace_handles WHERE workspace_id=NEW.workspace_id AND handle=candidate
      UNION ALL SELECT 1 FROM identities identity
        WHERE identity.kind='human' AND lower(identity.handle)=candidate
    );
    suffix := suffix+1;
    candidate := stem||'_'||suffix::text;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM workspace_handles WHERE identity_id=NEW.identity_id) THEN
    UPDATE identities SET workspace_handle_base=candidate WHERE id=NEW.identity_id AND workspace_handle_base IS NOT NULL;
  END IF;
  INSERT INTO workspace_handles(workspace_id,identity_id,handle) VALUES(NEW.workspace_id,NEW.identity_id,candidate);
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER beeline_workspace_handle BEFORE INSERT OR UPDATE OF workspace_id,identity_id ON memberships
FOR EACH ROW EXECUTE FUNCTION beeline_reserve_workspace_handle();
`;
