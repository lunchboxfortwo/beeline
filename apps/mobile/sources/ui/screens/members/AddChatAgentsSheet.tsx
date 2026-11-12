import React, { useState } from 'react';
import { Card, Checkbox, ListItem, Separator, YStack } from 'tamagui';
import { Check } from 'lucide-react-native';
import { Btn, Copy, Glyph, HEIGHT, SheetFrame } from '@/ui/grammar';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { Face } from '@/ui/screens/people/PeopleParts';
import type { PeopleRow } from '@/ui/screens/people/people-rows';

export function addLabel(count: number): string {
    return count ? `Add ${count} ${count === 1 ? 'agent' : 'agents'}` : 'Choose agents to add';
}

/**
 * Agents + in a chat: just the workspace agents not in it yet, ticked and
 * added with one primary action (today's `addRoomMember`). No options
 * (build spec decision 7); outside agents are added from People.
 */
export function AddChatAgentsSheet({ open, close, roomId, roomTag, workspaceName, candidates, onAdded }: {
    open: boolean; close: () => void; roomId: string; roomTag: string; workspaceName: string;
    candidates: readonly PeopleRow[]; onAdded: () => void;
}) {
    const [picked, setPicked] = useState<readonly string[]>([]);
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const chosen = picked.filter((id) => candidates.some((row) => row.id === id));
    const shut = () => { setPicked([]); setError(null); close(); };
    const toggle = (id: string) => setPicked((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
    const add = async () => {
        if (!chosen.length || adding) return;
        setAdding(true);
        setError(null);
        try {
            await monolithPhoneOperation('addRoomMember', { roomId, memberIds: chosen });
            onAdded();
            shut();
        } catch (reason) {
            setError(appErrorCopy(reason, 'Could not add chat members.'));
        } finally {
            setAdding(false);
        }
    };

    return (
        <SheetFrame open={open} close={shut} title="Add agents" testID="sheet-add-agent-member">
            {candidates.length ? (
                <YStack gap="3">
                    <Copy small quiet>{`Agents in ${workspaceName} that are not in ${roomTag} yet.`}</Copy>
                    <Card backgroundColor="raised" borderWidth={1} borderColor="stroke" paddingHorizontal="3">
                        {candidates.map((row, index) => {
                            const on = chosen.includes(row.id);
                            return (
                                <React.Fragment key={row.id}>
                                    <ListItem padding="0" paddingVertical="3" gap="3" minHeight={HEIGHT.sheetRow} backgroundColor="raised"
                                        role="checkbox" aria-checked={on} aria-label={`Choose ${row.handle}`} onPress={() => toggle(row.id)} testID={`pick-${row.id}`}>
                                        <Checkbox checked={on} width={24} height={24} borderRadius="sm" borderWidth={2} borderColor={on ? 'needsYou' : 'secondary'}
                                            backgroundColor="canvas" pointerEvents="none" aria-hidden>
                                            <Checkbox.Indicator><Glyph icon={Check} size={14} accent /></Checkbox.Indicator>
                                        </Checkbox>
                                        <Face row={row} />
                                        <YStack flex={1} minWidth={0}>
                                            <Copy>{row.handle}</Copy>
                                            {row.detail ? <Copy small quiet>{row.detail}</Copy> : null}
                                        </YStack>
                                    </ListItem>
                                    {index < candidates.length - 1 ? <Separator borderColor="stroke" /> : null}
                                </React.Fragment>
                            );
                        })}
                    </Card>
                    {error ? <Copy small quiet role="alert">{error}</Copy> : null}
                    <Btn kind="primary" label={addLabel(chosen.length)} disabled={!chosen.length || adding} onPress={() => void add()} testID="add-agents-confirm">
                        {addLabel(chosen.length)}
                    </Btn>
                </YStack>
            ) : (
                <Copy testID="agents-all-in">{`Every ${workspaceName} agent is already in ${roomTag}. To invite an outside agent or create one, use People.`}</Copy>
            )}
        </SheetFrame>
    );
}
