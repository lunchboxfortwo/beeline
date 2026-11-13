import { createHmac } from 'node:crypto';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { sameHexSignature } from './signature.js';
import type { ProviderAdapter } from './types.js';
export const key = 'stripe' as const;
export const adapter = {
  key,
  officialRegistry: 'com.stripe/mcp',
  webhook: {
    event: 'payment_intent.succeeded',
    catalog: {
      service: 'Stripe',
      event: 'payment_intent.succeeded',
      label: 'payment succeeded in Stripe',
    },
    initial(_id: string) {
      return { signingSecret: null, providerId: null };
    },
    verify(raw, headers, body, hook, now) {
      const header = headers['stripe-signature'];
      if (typeof header !== 'string' || body.type !== hook.event) return undefined;
      const parts = new Map(
        header.split(',').map((part) => part.trim().split('=', 2) as [string, string]),
      );
      const timestamp = parts.get('t');
      if (
        !timestamp ||
        !/^\d{10}$/.test(timestamp) ||
        Math.abs(now / 1000 - Number(timestamp)) > 300
      )
        return undefined;
      const signature = createHmac('sha256', hook.signing_secret)
        .update(`${timestamp}.`)
        .update(raw)
        .digest();
      if (
        !header
          .split(',')
          .some((part) =>
            sameHexSignature(
              signature,
              part.trim().startsWith('v1=') ? part.trim().slice(3) : undefined,
            ),
          )
      )
        return undefined;
      if (typeof body.id !== 'string' || !body.id) return undefined;
      return body.id;
    },
    summary(body) {
      const data =
        body.data && typeof body.data === 'object' && !Array.isArray(body.data)
          ? (body.data as Record<string, unknown>)
          : {};
      const subject =
        data.object && typeof data.object === 'object' && !Array.isArray(data.object)
          ? (data.object as Record<string, unknown>)
          : {};
      return {
        object: systemMessage('provider-webhooks.a-stripe-payment'),
        payload: {
          source: 'service',
          service: 'Stripe',
          id: typeof subject.id === 'string' ? subject.id : undefined,
          title: undefined,
          amount: typeof subject.amount === 'number' ? subject.amount : undefined,
          currency:
            typeof subject.currency === 'string' ? subject.currency.slice(0, 10) : undefined,
        },
      };
    },
  },
} satisfies ProviderAdapter;
