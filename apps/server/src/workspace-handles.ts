/** Identity handles remain global fallback addresses during serving overlap.
 * Workspace reservations survive renaming and migration replay, until departure. */
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
  AND member.removed_at IS NULL
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

CREATE OR REPLACE FUNCTION beeline_assign_workspace_handle(who text,place uuid)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE preferred text; stem text; candidate text; suffix numeric := 1;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM identities WHERE id=who AND kind='agent') THEN RETURN NULL; END IF;
  SELECT handle INTO candidate FROM workspace_handles WHERE workspace_id=place AND identity_id=who;
  IF candidate IS NOT NULL THEN RETURN candidate; END IF;
  -- All arrivals, including DM participants from other workspaces, reserve in
  -- the place's workspace. Serialize first reservations with other arrivals.
  PERFORM id FROM workspaces WHERE id=place FOR UPDATE;
  SELECT handle INTO candidate FROM workspace_handles WHERE workspace_id=place AND identity_id=who;
  IF candidate IS NOT NULL THEN RETURN candidate; END IF;
  SELECT COALESCE(workspace_handle_base,handle) INTO preferred
    FROM identities WHERE id=who FOR UPDATE;
  IF preferred IS NULL THEN RETURN NULL; END IF;
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
      SELECT 1 FROM workspace_handles WHERE workspace_id=place AND handle=candidate
      UNION ALL SELECT 1 FROM identities identity
        WHERE identity.kind='human' AND lower(identity.handle)=candidate
    );
    suffix := suffix+1;
    candidate := stem||'_'||suffix::text;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM workspace_handles WHERE identity_id=who) THEN
    UPDATE identities SET workspace_handle_base=candidate WHERE id=who AND workspace_handle_base IS NOT NULL;
  END IF;
  INSERT INTO workspace_handles(workspace_id,identity_id,handle) VALUES(place,who,candidate);
  RETURN candidate;
END;
$$;
CREATE OR REPLACE FUNCTION beeline_reserve_workspace_handle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.removed_at IS NULL THEN
    PERFORM beeline_assign_workspace_handle(NEW.identity_id,NEW.workspace_id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER beeline_workspace_handle BEFORE INSERT OR UPDATE OF workspace_id,identity_id,removed_at ON memberships
FOR EACH ROW EXECUTE FUNCTION beeline_reserve_workspace_handle();

CREATE OR REPLACE FUNCTION beeline_release_workspace_handle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.workspace_id=NEW.workspace_id AND OLD.identity_id=NEW.identity_id
    AND NEW.removed_at IS NULL THEN RETURN NULL; END IF;
  -- Releasing only deletes this member's reservation. Native row/unique locks
  -- order reuse without taking a Workspace lock after a membership/Room lock.
  DELETE FROM workspace_handles handle
    WHERE handle.workspace_id=OLD.workspace_id AND handle.identity_id=OLD.identity_id
      AND NOT EXISTS(SELECT 1 FROM memberships member
        WHERE member.workspace_id=OLD.workspace_id AND member.identity_id=OLD.identity_id
          AND member.removed_at IS NULL);
  RETURN NULL;
END;
$$;
CREATE OR REPLACE TRIGGER beeline_workspace_handle_release
AFTER DELETE OR UPDATE OF workspace_id,identity_id,removed_at ON memberships
FOR EACH ROW EXECUTE FUNCTION beeline_release_workspace_handle();
`;
