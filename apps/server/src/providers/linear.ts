import { createHmac, randomBytes } from 'node:crypto';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { sameHexSignature } from './signature.js';
import type { ProviderAdapter } from './types.js';
export const key = 'linear' as const;
export const adapter = {
  key,
  officialRegistry: 'app.linear/linear',
  webhook: {
    event: 'issue.created',
    catalog: { service: 'Linear', event: 'issue.created', label: 'new issue in Linear' },
    initial(id: string) {
      return { signingSecret: randomBytes(32).toString('hex'), providerId: id };
    },
    verify(raw, headers, body, hook, now) {
      const signature = createHmac('sha256', hook.signing_secret).update(raw).digest();
      if (
        !sameHexSignature(signature, headers['linear-signature']) ||
        typeof body.webhookTimestamp !== 'number' ||
        Math.abs(now - body.webhookTimestamp) > 60_000 ||
        body.webhookId !== hook.provider_id ||
        body.type !== 'Issue' ||
        body.action !== 'create' ||
        headers['linear-event'] !== 'Issue'
      )
        return undefined;
      const delivery = headers['linear-delivery'];
      if (typeof delivery !== 'string' || !delivery) return undefined;
      return delivery;
    },
    summary(body) {
      const subject =
        body.data && typeof body.data === 'object' && !Array.isArray(body.data)
          ? (body.data as Record<string, unknown>)
          : {};
      return {
        object: systemMessage('provider-webhooks.a-linear-issue'),
        payload: {
          source: 'service',
          service: 'Linear',
          id: typeof subject.id === 'string' ? subject.id : undefined,
          title: typeof subject.title === 'string' ? subject.title.slice(0, 500) : undefined,
          amount: undefined,
          currency: undefined,
        },
      };
    },
  },
} satisfies ProviderAdapter;
