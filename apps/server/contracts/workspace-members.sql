-- Release only after the no-reader cleanup replaces serving and rollback images.
ALTER TABLE free_agents DROP COLUMN IF EXISTS workspace_id;
ALTER TABLE rooms_mcp_members DROP COLUMN IF EXISTS workspace_ids;
