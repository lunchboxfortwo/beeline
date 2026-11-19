import { describe, expect, it } from 'vitest';
import { foldPrLifecycleRuns, lifecycleItem, lifecycleSummary } from './pr-lifecycle';
import type { NotificationLifecycleRun } from './pr-lifecycle';
import type { SystemLineMessage } from './system-lines';

function event(id: string, type: 'pull-request' | 'issue', action: string, number: number): SystemLineMessage {
  return {
    id, text: '', timestamp: 1,
    githubEvent: {
      type, action, actor: 'octocat', title: 'Requested work',
      url: `https://github.com/owner/widgets/${type === 'issue' ? 'issues' : 'pull'}/${number}`,
    },
  };
}

function subscription(id: string, verb: string, number: number): SystemLineMessage {
  return {
    id, text: '', timestamp: 2, isSystemNotice: true,
    systemEvent: {
      subject: { kind: 'github', name: 'owner/widgets' }, verb,
      object: { text: 'Requested work', url: `https://github.com/owner/widgets/pull/${number}` },
    },
  };
}

function run(messages: SystemLineMessage[]): NotificationLifecycleRun {
  const folded = foldPrLifecycleRuns(messages);
  expect(folded).toHaveLength(1);
  return (folded[0] as SystemLineMessage & { notificationLifecycleRun: NotificationLifecycleRun }).notificationLifecycleRun;
}

describe('lifecycle-1: stored GitHub lifecycle summaries', () => {
  it('counts a close once across stored event formats and orders groups consistently', () => {
    const messages = [
      event('issue-close', 'issue', 'closed', 10),
      subscription('subscription-close', 'closed pull request', 42),
      event('issue-open', 'issue', 'opened', 11),
      event('pr-merge', 'pull-request', 'merged', 43),
      event('pr-open', 'pull-request', 'opened', 42),
      event('pr-close', 'pull-request', 'closed', 42),
      subscription('legacy-close', 'closed a pull request', 42),
      event('another-close', 'pull-request', 'closed', 44),
    ];
    const items = run(messages).items;
    // Committed events remain available in the expanded run and for read cursors.
    expect(items).toHaveLength(messages.length);
    expect(lifecycleSummary(items)).toBe('1 PR opened · 1 PR merged · 2 PRs closed · 1 issue filed · 1 issue closed');
    expect(lifecycleSummary(run([...messages].reverse()).items)).toBe(lifecycleSummary(items));
    expect(lifecycleItem(messages[1])?.state.toLowerCase()).toBe('closed');
  });

  it.each([
    [4, 12, '4 PRs merged · 12 issues filed'],
    [1, 1, '1 PR merged · 1 issue filed'],
    [4, 0, '4 PRs merged'],
    [0, 1, '1 issue filed'],
  ] as const)('keeps the noun with %i merged PRs and %i filed issues when no PRs opened', (prs, issues, expected) => {
    const messages = [
      ...Array.from({ length: issues }, (_, index) => event(`issue-${index}`, 'issue', 'opened', index + 1)),
      ...Array.from({ length: prs }, (_, index) => event(`pr-${index}`, 'pull-request', 'merged', index + 1)),
    ];
    expect(lifecycleSummary(run(messages).items)).toBe(expected);
  });

  it('names each GitHub count', () => {
    const messages = [
      ...Array.from({ length: 3 }, (_, i) => event(`open-${i}`, 'pull-request', 'opened', i)),
      ...Array.from({ length: 4 }, (_, i) => event(`merge-${i}`, 'pull-request', 'merged', i)),
      ...Array.from({ length: 12 }, (_, i) => event(`file-${i}`, 'issue', 'opened', i)),
      ...Array.from({ length: 28 }, (_, i) => event(`close-${i}`, 'issue', 'closed', i)),
    ];
    expect(lifecycleSummary(run(messages).items)).toBe('3 PRs opened · 4 PRs merged · 12 issues filed · 28 issues closed');
  });

  it.each(['check', 'payment', 'wallet', 'corner', 'notice'] as const)(
    'names the %s group across states', (kind) => {
      const item = { id: 'a', title: '', kindLine: '', actor: '', updatedBy: 'a', kind };
      expect(lifecycleSummary([
        { ...item, state: 'Opened' },
        { ...item, state: 'Closed' },
        { ...item, state: 'Closed' },
      ])).toBe(`2 ${kind}s closed · 1 ${kind} opened`);
    },
  );

  it.each([
    ['pushed', undefined, '1 commit', '2 commits'],
    ['found merge conflicts in', 42, '1 merge conflict', '2 merge conflicts'],
    ['requested review of', 42, '1 review requested', '2 reviews requested'],
    ['found failing checks on', 42, '1 check failed', '2 checks failed'],
  ] as const)('summarizes %s as a complete phrase without changing expanded items', (verb, number, single, plural) => {
    const first = subscription('first', verb, number ?? 42);
    const second = subscription('second', verb, number === undefined ? 43 : number + 1);
    if (number === undefined) {
      first.systemEvent!.object!.headSha = 'a'.repeat(40);
      second.systemEvent!.object!.headSha = 'b'.repeat(40);
      first.systemEvent!.object!.url = 'https://github.com/owner/widgets/compare/before...after';
      second.systemEvent!.object!.url = 'https://github.com/owner/widgets/compare/after...next';
    }
    const items = run([first, second]).items;
    const before = structuredClone(items);
    expect(lifecycleSummary(items.slice(0, 1))).toBe(single);
    expect(lifecycleSummary(items)).toBe(plural);
    expect(items).toEqual(before);
    if (verb !== 'found failing checks on') expect(items[0].displayText).toBeDefined();
  });

  it('keeps each specialized phrase complete in a mixed run', () => {
    const push = subscription('push', 'pushed', 42);
    push.systemEvent!.object!.headSha = 'a'.repeat(40);
    push.systemEvent!.object!.url = 'https://github.com/owner/widgets/compare/before...after';
    const messages = [
      push,
      subscription('conflict', 'found merge conflicts in', 42),
      subscription('review', 'requested review of', 42),
      subscription('checks', 'found failing checks on', 42),
      subscription('duplicate-conflict', 'found merge conflicts in', 42),
    ];
    const items = run(messages).items;
    expect(items).toHaveLength(messages.length);
    expect(lifecycleSummary(items)).toBe('1 commit · 1 check failed · 1 review requested · 1 merge conflict');
    expect(lifecycleSummary([...items].reverse())).toBe(lifecycleSummary(items));
  });

  it('keeps repositories, lifecycle kinds and runs distinct', () => {
    const closed = event('closed', 'pull-request', 'closed', 42);
    const otherRepo = event('other-repo', 'pull-request', 'closed', 42);
    otherRepo.githubEvent!.url = 'https://github.com/owner/other/pull/42';
    expect(lifecycleSummary(run([
      closed, otherRepo, event('issue', 'issue', 'closed', 42),
      event('opened', 'pull-request', 'opened', 42),
      subscription('duplicate', 'closed pull request', 42),
    ]).items)).toBe('1 PR opened · 2 PRs closed · 1 issue closed');
    const folded = foldPrLifecycleRuns([closed, { id: 'chat', text: 'Hello', timestamp: 2 }, subscription('later', 'closed pull request', 42)]);
    expect(folded).toHaveLength(3);
    for (const index of [0, 2]) {
      const row = folded[index] as SystemLineMessage & { notificationLifecycleRun: NotificationLifecycleRun };
      expect(lifecycleSummary(row.notificationLifecycleRun.items)).toBe('1 PR closed');
    }
  });

  it('puts other groups after the fixed order and ignores URL fragments for duplicates', () => {
    const duplicate = subscription('duplicate', 'closed pull request', 42);
    duplicate.systemEvent!.object!.url += '/?tab=conversation#event';
    const items = run([
      event('reopened', 'issue', 'reopened', 9),
      event('commented', 'pull-request', 'commented', 43),
      event('closed', 'pull-request', 'closed', 42), duplicate,
    ]).items;
    expect(lifecycleSummary(items)).toBe('1 PR closed · 1 issue reopened · 1 PR commented');
    expect(lifecycleSummary([])).toBe('');
  });

});

it.each(['found failing checks on', 'failed check'])('classifies %s as a small check row even with a PR URL', verb => {
  const message = subscription('failure', verb, 112);
  message.systemEvent = { ...message.systemEvent!, kind: 'check-failed',
    object: { ...message.systemEvent!.object!, headSha: '82828a8' + '1'.repeat(33) } };
  expect(lifecycleItem(message)).toMatchObject({ kind: 'check', state: 'Checks failed', displayText: 'Failed check 82828a8', headSha: '82828a8' + '1'.repeat(33) });
  expect(lifecycleSummary(run([message]).items)).toBe('1 check failed');
});


it('counts the commits inside one push event', () => {
  const message = subscription('push', '3 commits pushed · aaaaaaa', 42);
  message.systemEvent!.object!.headSha = 'a'.repeat(40);
  expect(lifecycleSummary(run([message]).items)).toBe('3 commits');
});

it('drops a historical suite duplicate when the same head names a failed job', () => {
  const job = subscription('job', 'failed a check', 42);
  job.systemEvent!.object = { text: 'TYPECHECK', headSha: 'a'.repeat(40) };
  const suite = subscription('suite', 'failed a check', 42);
  suite.systemEvent!.object = { text: 'GitHub Actions check suite', headSha: 'a'.repeat(40) };
  const items = run([job, suite]).items;
  expect(items).toHaveLength(1);
  expect(items[0].displayText).toBe('Check failed · TYPECHECK · aaaaaaa');
  expect(lifecycleSummary(items)).toBe('1 check failed');
});
