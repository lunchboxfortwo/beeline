import type { SystemEvent } from '@beeline/api-contract/phone';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';

export function workflowExpiryLine(slug: string, stepKind: string | null | undefined): SystemEvent {
  const words = slug.replace(/[_-]+/g, ' ').trim()
    .replace(/(\b\d{1,2} )(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/g,
      (_, day: string, month: string) => day + month[0]!.toUpperCase() + month.slice(1));
  const name = words ? words[0]!.toUpperCase() + words.slice(1) : systemMessage('workflow-runs.workflow');
  return stepKind === 'gate'
    ? {
        subject: { kind: 'system', name: systemMessage('workflow-runs.approval') },
        verb: systemMessage('workflow-runs.timed-out-for'),
        object: { text: name },
      }
    : { subject: { kind: 'system', name }, verb: systemMessage('workflow-runs.timed-out') };
}
