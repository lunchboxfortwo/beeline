import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  operation: vi.fn(), authorize: vi.fn(), setParams: vi.fn(), complete: vi.fn(),
  query: {} as { githubStar?: string },
  router: { setParams: vi.fn() },
  register: vi.fn(async () => () => undefined),
}));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: mocks.operation }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ register: mocks.register }) }));
vi.mock('@/auth/github-star-session', () => ({
  authorizeGitHubStar: mocks.authorize,
  githubStarRedirectUri: (id: string) => `beeline://beeline/chat/${id}`,
}));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => mocks.query, useRouter: () => mocks.router }));
vi.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: mocks.complete }));
vi.mock('./TranscriptCard', () => ({ TranscriptCard: (props: unknown) => React.createElement('TranscriptCard', props as object) }));

const roomId = '22222222-2222-4222-8222-222222222222';
const prompt = { milestone: 3, repository: 'Beeline-Work/beeline', url: 'https://github.com/Beeline-Work/beeline' };
let unmount: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.query = {};
  mocks.operation.mockImplementation(async (name: string) => name === 'readStarPrompt' ? { prompt } : { outcome: 'starred' });
  mocks.authorize.mockResolvedValue(true);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => {
  act(() => unmount?.());
  unmount = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount() {
  const { useStarPrompt, StarPromptCard } = await import('./StarPromptCard');
  let state!: ReturnType<typeof useStarPrompt>;
  function Harness() {
    state = useStarPrompt(roomId, true);
    return state.prompt || state.starred ? <StarPromptCard {...state} onAnswer={state.answer} /> : null;
  }
  let renderer: any;
  await act(async () => { renderer = create(<Harness />); });
  await act(async () => { await vi.runAllTimersAsync(); });
  unmount = () => renderer.unmount();
  return { get state() { return state; }, renderer };
}

it('keeps the existing card and stars in place with a short thanks', async () => {
  const view = await mount();
  let card = view.renderer.root.findByType('TranscriptCard');
  expect(card.props.title).toBe('Star Beeline on GitHub');
  expect(card.props.actions.map((action: { label: string }) => action.label)).toEqual(['Not now', 'Star']);
  await act(async () => { await view.state.answer('star'); });
  expect(mocks.authorize).not.toHaveBeenCalled();
  expect(mocks.operation).toHaveBeenCalledWith('answerStarPrompt', {
    action: 'star', milestone: 3, redirectUri: `beeline://beeline/chat/${roomId}`,
  });
  card = view.renderer.root.findByType('TranscriptCard');
  expect(card.props.title).toBe('Thanks for starring Beeline!');
  expect(card.props.actions).toBeUndefined();
  act(() => view.state.accept({ prompt: { ...prompt, milestone: 300 } }));
  expect(view.state.prompt).toBeNull();
  act(() => unmount?.());
  unmount = undefined;
  mocks.operation.mockClear();
  const reopened = await mount();
  expect(reopened.state.prompt).toBeNull();
  expect(reopened.state.starred).toBe(false);
  expect(mocks.operation).not.toHaveBeenCalled();
});

it('opens authorization and waits for the server star before showing thanks', async () => {
  mocks.operation.mockImplementation(async (name: string) => name === 'readStarPrompt' ? { prompt }
    : { outcome: 'open', url: 'https://github.com/login/oauth/authorize?state=github_star_fixture' });
  let complete!: (value: boolean) => void;
  mocks.authorize.mockReturnValue(new Promise<boolean>(resolve => { complete = resolve; }));
  const view = await mount();
  let answering!: Promise<void>;
  await act(async () => { answering = view.state.answer('star'); });
  expect(view.state.starred).toBe(false);
  expect(view.state.prompt).toEqual(prompt);
  expect(mocks.authorize).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?state=github_star_fixture', `beeline://beeline/chat/${roomId}`);
  await act(async () => { complete(true); await answering; });
  expect(view.state.prompt).toBeNull();
  expect(view.renderer.root.findByType('TranscriptCard').props.title).toBe('Thanks for starring Beeline!');
});

it.each(['denied', 'restricted'])('keeps the card retryable after GitHub is %s', async kind => {
  mocks.operation.mockImplementation(async (name: string) => name === 'readStarPrompt' ? { prompt }
    : { outcome: 'open', url: 'https://github.com/login/oauth/authorize' });
  if (kind === 'denied') mocks.authorize.mockRejectedValue(new Error('browser canceled'));
  else mocks.authorize.mockResolvedValue(false);
  const view = await mount();
  await act(async () => { await view.state.answer('star'); });
  expect(view.state.prompt).toEqual(prompt);
  expect(view.state.busy).toBeNull();
  expect(view.state.starred).toBe(false);
});

it('shows thanks in the originating chat after a cold authorization return', async () => {
  mocks.query = { githubStar: 'starred' };
  const view = await mount();
  expect(view.state.starred).toBe(true);
  expect(view.state.prompt).toBeNull();
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(mocks.router.setParams).toHaveBeenCalledWith({ githubStar: undefined });
  expect(view.renderer.root.findByType('TranscriptCard').props.title).toBe('Thanks for starring Beeline!');
});
