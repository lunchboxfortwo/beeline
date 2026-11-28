/** Server-owned card for choosing or creating a Room repository. */
export type OnboardingRepository = {
  readonly id: number;
  readonly fullName: string;
  readonly installationId: number;
  readonly defaultBranch: string;
  readonly current: boolean;
};
export type RepositoryOnboardingCard = {
  readonly id: string;
  readonly roomId: string;
  readonly agentId: string;
  readonly requesterId: string;
  readonly kind: 'repository';
  readonly state: 'install_missing' | 'no_repo_linked' | 'repo_linked';
  readonly status: 'open' | 'settled';
  readonly resolution?: 'linked' | 'created' | 'superseded';
  readonly canLink: boolean;
  readonly ownerHandle?: string;
  readonly githubLinked?: boolean;
  readonly repository?: string;
  readonly defaultName: string;
  readonly installationId?: number;
  readonly installationAccount?: string;
  readonly repositories: readonly OnboardingRepository[];
  readonly selected?: string;
};
export type RepositoryOnboardingAction = {
  readonly roomId: string;
  readonly cardId: string;
  readonly action: 'create' | 'link' | 'install' | 'organization' | 'refresh';
  readonly repositoryId?: number;
  readonly name?: string;
  readonly redirectUri?: string;
};

/** Single repository name rule shared by server sanitization, validation, and the mobile editor. */
export function isValidRepositoryName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 100 &&
    name !== '.' &&
    name !== '..' &&
    !/\.git$/i.test(name) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  );
}

export function readRepositoryOnboardingCard(value: unknown): RepositoryOnboardingCard | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const key = (x: unknown) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
  const uuid = (x: unknown) => typeof x === 'string' && /^[0-9a-f-]{36}$/.test(x);
  const text = (x: unknown) => typeof x === 'string' && x.length > 0;
  const positive = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x > 0;
  if (!key(v.id) || !uuid(v.roomId) || !key(v.agentId) || !key(v.requesterId) ||
      v.kind !== 'repository' ||
      !['install_missing', 'no_repo_linked', 'repo_linked'].includes(String(v.state)) ||
      !['open', 'settled'].includes(String(v.status)) ||
      (v.resolution !== undefined && !['linked', 'created', 'superseded'].includes(String(v.resolution))) ||
      typeof v.canLink !== 'boolean' || !text(v.defaultName) ||
      (v.repository !== undefined && !text(v.repository)) ||
      (v.ownerHandle !== undefined && !text(v.ownerHandle)) ||
      (v.githubLinked !== undefined && typeof v.githubLinked !== 'boolean') ||
      (v.installationId !== undefined && !positive(v.installationId)) ||
      (v.installationAccount !== undefined && !text(v.installationAccount)) ||
      (v.selected !== undefined && !text(v.selected)) ||
      !Array.isArray(v.repositories) || !v.repositories.every(r => r && positive(r.id) &&
        positive(r.installationId) && text(r.fullName) && text(r.defaultBranch) && typeof r.current === 'boolean')) return undefined;
  return {
    id: v.id as string,
    roomId: v.roomId as string,
    agentId: v.agentId as string,
    requesterId: v.requesterId as string,
    kind: 'repository',
    state: v.state as RepositoryOnboardingCard['state'],
    status: v.status as RepositoryOnboardingCard['status'],
    ...(v.resolution !== undefined ? { resolution: v.resolution as RepositoryOnboardingCard['resolution'] } : {}),
    canLink: v.canLink as boolean,
    ...(v.ownerHandle !== undefined ? { ownerHandle: v.ownerHandle as string } : {}),
    ...(v.githubLinked !== undefined ? { githubLinked: v.githubLinked as boolean } : {}),
    ...(v.repository !== undefined ? { repository: v.repository as string } : {}),
    defaultName: v.defaultName as string,
    ...(v.installationId !== undefined ? { installationId: v.installationId as number } : {}),
    ...(v.installationAccount !== undefined ? { installationAccount: v.installationAccount as string } : {}),
    repositories: (v.repositories as OnboardingRepository[]).map(r => ({
      id: r.id,
      fullName: r.fullName,
      installationId: r.installationId,
      defaultBranch: r.defaultBranch,
      current: r.current,
    })),
    ...(v.selected !== undefined ? { selected: v.selected as string } : {}),
  };
}
