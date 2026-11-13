/** Public repository mark from the linked installation, inherited by its threads. */
export function repositoryMarkColumnsSql(room: string): string {
  const source = `SELECT source.*,installation.account_avatar_url
    FROM rooms source LEFT JOIN github_repositories repository ON repository.full_name=source.repository_name
    LEFT JOIN github_installations installation ON installation.installation_id=COALESCE(source.github_installation_id,repository.installation_id)
    WHERE source.id=COALESCE(${room}.parent_id,${room}.id) AND source.repository_resolution='repository'`;
  return `(SELECT mark.account_avatar_url FROM (${source}) mark) repository_avatar,
    (SELECT 'https://github.githubassets.com/favicons/favicon.png' FROM (${source}) mark
      WHERE mark.repository_remote ~ 'github[.]com[:/]') repository_favicon`;
}
