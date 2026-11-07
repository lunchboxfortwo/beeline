import React from 'react';
import type { RoomViewMember } from '@beeline/api-contract/phone';
import { openExternalUrl } from '@/utils/open-external-url';
import { IndexRow } from './IndexRow';

/** Route facts belong to the server. Silence and unfinished host receipts never imply offline. */
export function AgentDeliveryStatus({ members }: { members: readonly RoomViewMember[] }) {
  const offline = members.filter(
    (member) => member.identity.kind === 'agent' && member.delivery?.offline === true,
  );
  if (!offline.length) return null;
  const reconnectUrl = offline[0].delivery?.reconnectUrl;
  if (!reconnectUrl) return null;
  const names = offline.map((member) => member.identity.name).join(', ');
  return (
    <IndexRow
      inset="flush"
      title={`${names} ${offline.length === 1 ? 'is' : 'are'} offline`}
      action="Connect again"
      onPress={() => {
        void openExternalUrl(reconnectUrl).catch(() => undefined);
      }}
      testID="agent-delivery-offline"
    />
  );
}
