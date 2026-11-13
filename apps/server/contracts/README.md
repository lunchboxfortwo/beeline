# Column contracts

Add an idempotent column drop here only in a later release than the code that
stopped reading and writing it. The release guard checks the candidate and
both preceding serving images, including the supported rollback image.

The server leg applies these files only after both Machines serve the new
image. Each statement must be a single `ALTER TABLE` column drop with `IF EXISTS`.
Other migrations remain on the existing predeployment path.

`workspace-members.sql` belongs to the release after the membership no-reader
cleanup. It removes only the retired free/MCP Workspace fields; ordinary
`memberships` rows and agent lifecycle/connection metadata stay intact. The
same release's normal migration removes the unused `effective_memberships`
view alias. The canonical `room_access` projection remains.

The retired owner and star milestone columns remain compatibility storage.
