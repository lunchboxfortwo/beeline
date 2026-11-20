/** The repository chat mark column, inherited by its threads: `<chat id>/<icon hash>` when the chat's linked
 * repository has a stored icon (repository-icons.ts), else NULL. A database read only; never GitHub. */
export function repositoryMarkColumnsSql(room: string): string {
  return `(SELECT source.id || '/' || icon.icon_hash FROM rooms source
    JOIN github_repositories repository ON repository.full_name=source.repository_name
    JOIN repository_icons icon ON icon.repository_id=repository.repository_id AND icon.icon_hash IS NOT NULL
    WHERE source.id=COALESCE(${room}.parent_id,${room}.id) AND source.repository_resolution='repository') repository_icon`;
}
