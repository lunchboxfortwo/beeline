/** “#x is public: …” / “#x is private: …”, from the Room's own visibility. */
export function visibilityLine(tag: string, visibility: 'public' | 'invite-only' | undefined, workspaceName: string): string | undefined {
    if (visibility === 'public') return `${tag} is public: anyone in ${workspaceName} can join it.`;
    if (visibility === 'invite-only') return `${tag} is private: only the people added here can see it.`;
    return undefined;
}
