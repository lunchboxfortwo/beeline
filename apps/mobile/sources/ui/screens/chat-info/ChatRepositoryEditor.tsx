import React, { useEffect, useState } from 'react';
import { XStack } from 'tamagui';
import { Btn, Copy, Row, SheetFrame } from '@/ui/grammar';
import { RepoList } from '@/components/buzz/RepoList';
import { SelectedRepositoryPill } from '@/components/buzz/SelectedRepositoryPill';
import type { GitHubRepositoryListResult } from '@beeline/api-contract/phone';
import type { RepoCandidate } from '@/buzz/room-repo-picker';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { confirmRoomRepoReplacement } from '@/buzz/room-repo-replacement';
import { CORNER_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { Modal } from '@/modal';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

type ListedRepository = GitHubRepositoryListResult['repositories'][number];
const repositoryCandidate = (repository: ListedRepository): RepoCandidate => ({
    key: `github:${repository.id}`, name: repository.fullName,
    remote: `git://github.com/${repository.fullName}`,
    githubInstallationId: repository.installationId, defaultBranch: repository.defaultBranch,
    private: repository.private,
});

type Props = {
    roomId: string;
    current: (RepoCandidate & { targetBranch?: string }) | null;
    canEditRepository: boolean;
    disabled: boolean;
    openCorners: number;
    refresh: () => Promise<unknown>;
    onBusyChange: (saving: boolean) => void;
    onOpen: () => void;
};

/** Keep opening, searching and drafting inside the picker, off the Chat info render path. */
export function ChatRepositoryEditor({ roomId, current, canEditRepository, disabled, openCorners, refresh, onBusyChange, onOpen }: Props) {
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const busy = disabled || saving;
    const [repositoryDraft, setRepositoryDraft] = useState<RepoCandidate | null>(null);
    const [repositories, setRepositories] = useState<readonly ListedRepository[]>([]);
    const [repositoriesLoading, setRepositoriesLoading] = useState(false);
    const [editError, setEditError] = useState<string | null>(null);
    useEffect(() => { setOpen(false); }, [roomId]);
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        let refreshed = false;
        void monolithPhoneOperation('listGitHubRepositories', { refresh: true }).then(result => {
            refreshed = true;
            if (!cancelled) setRepositories(result.repositories);
        }).catch(() => undefined).finally(() => { if (!cancelled) setRepositoriesLoading(false); });
        void monolithPhoneOperation('listGitHubRepositories', { refresh: false }).then(result => {
            if (!cancelled && !refreshed) setRepositories(result.repositories);
        }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [open, roomId]);

    const openRepository = () => {
        if (!canEditRepository || busy) return;
        onOpen();
        setRepositoryDraft(current ? { ...current, defaultBranch: current.targetBranch } : null);
        setRepositoriesLoading(true); setRepositories([]); setEditError(null); setOpen(true);
    };
    const saveRepository = async () => {
        if (!canEditRepository || busy || (repositoryDraft?.key ?? null) === (current?.key ?? null)) return;
        setSaving(true); onBusyChange(true); setEditError(null);
        try {
            if (repositoryDraft) {
                if (!repositoryDraft.remote) return;
                if (!(await confirmRoomRepoReplacement(current?.name, openCorners))) return;
                await monolithPhoneOperation('setRoomRepository', {
                    roomId, key: repositoryDraft.key, name: repositoryDraft.name, remote: repositoryDraft.remote,
                    targetBranch: repositoryDraft.defaultBranch ?? 'main',
                    ...(repositoryDraft.githubInstallationId ? { githubInstallationId: repositoryDraft.githubInstallationId } : {}),
                });
            } else {
                if (!current) return;
                const hasOpenCorners = openCorners > 0;
                const confirmed = await Modal.confirm(`Unlink ${current.name}?`, hasOpenCorners
                    ? `This ${ROOM_LABEL} becomes chat-only. Open ${CORNER_LABEL}s keep their copies of the repo; messages and history are untouched.`
                    : `This ${ROOM_LABEL} becomes chat-only. Messages and history are untouched.`,
                    { cancelText: 'Cancel', confirmText: 'Unlink repo', destructive: true });
                if (!confirmed) return;
                await monolithPhoneOperation('removeRoomRepository', { roomId });
            }
            await refresh();
            setOpen(false);
        } catch (reason) { setEditError(appErrorCopy(reason, 'Could not change repository.')); }
        finally { setSaving(false); onBusyChange(false); }
    };

    return <>
        <Row label="Repository" value={current?.name ?? 'None'} onPress={canEditRepository ? openRepository : undefined} testID="chat-repository" />
        <SheetFrame open={open && canEditRepository} close={() => { if (!busy) setOpen(false); }} title="Repository" testID="chat-repository-sheet">
            <SelectedRepositoryPill repository={repositoryDraft} disabled={busy} onClear={() => setRepositoryDraft(null)} testIDPrefix="chat-repository" />
            <RepoList candidates={repositories} getCandidate={repositoryCandidate} currentKey={repositoryDraft?.key ?? null} loading={repositoriesLoading}
                onSelect={candidate => { if (!busy) setRepositoryDraft(candidate); }} draftContext={roomId} testIDPrefix="chat-repository-list" />
            {editError ? <Copy small quiet role="alert">{editError}</Copy> : null}
            <XStack gap="2" justifyContent="flex-end">
                <Btn kind="quiet" label="Cancel" disabled={busy} onPress={() => setOpen(false)}>Cancel</Btn>
                <Btn kind="primary" label="Save" disabled={busy || (repositoryDraft?.key ?? null) === (current?.key ?? null)}
                    onPress={() => void saveRepository()} testID="chat-repository-save">{saving ? 'Saving…' : 'Save'}</Btn>
            </XStack>
        </SheetFrame>

    </>;
}
