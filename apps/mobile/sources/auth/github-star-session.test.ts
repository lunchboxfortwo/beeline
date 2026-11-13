import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ open: vi.fn(), subscribe: vi.fn(), desktop: false }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-linking', () => ({ createURL: (path: string) => `beeline://${path}` }));
vi.mock('@/utils/isDesktopShell', () => ({ isDesktopShell: () => mocks.desktop }));
vi.mock('./desktop-auth-session', () => ({ openAccountAuthSession: mocks.open, subscribeToAuthUrls: mocks.subscribe }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: mocks.open }));
import { authorizeGitHubStar, githubStarRedirectUri } from './github-star-session';

beforeEach(() => { vi.clearAllMocks(); mocks.desktop = false; mocks.subscribe.mockReturnValue({ remove: vi.fn() }); });

it.each([false, true])('returns to the same chat on native and desktop (desktop=%s)', desktop => {
  mocks.desktop = desktop;
  expect(githubStarRedirectUri('room-id')).toBe('beeline://beeline/chat/room-id');
});

it.each(['starred', 'failed'])('reads the server result after the browser returns (%s)', async outcome => {
  const redirect = githubStarRedirectUri('room-id');
  mocks.open.mockResolvedValue({ type: 'success', url: `${redirect}?githubStar=${outcome}` });
  expect(await authorizeGitHubStar('https://github.com/login/oauth/authorize', redirect)).toBe(outcome === 'starred');
  expect(mocks.open).toHaveBeenCalledWith('https://github.com/login/oauth/authorize', redirect,
    expect.objectContaining({ createTask: false }));
});

it('never opens a repository-page fallback from an older server', async () => {
  await expect(authorizeGitHubStar('https://github.com/Beeline-Work/beeline', githubStarRedirectUri('room-id'))).rejects.toThrow('GitHub authorization is required');
  expect(mocks.open).not.toHaveBeenCalled();
});
