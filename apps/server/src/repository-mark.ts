/** The repository chat mark column, inherited by its threads: the chat whose committed icon file is the picture. */
export function repositoryMarkColumnsSql(room: string): string {
  // The icon endpoint serves the repository's own committed icon file, or 404 when it has none.
  return `(SELECT source.id FROM rooms source JOIN github_repositories repository ON repository.full_name=source.repository_name
    WHERE source.id=COALESCE(${room}.parent_id,${room}.id) AND source.repository_resolution='repository') repository_icon_room`;
}
