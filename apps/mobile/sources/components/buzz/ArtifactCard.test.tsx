import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { resetClientState } from '@/sync/client-reset';

const host = vi.hoisted(() => ({
  os: 'web', disk: new Map<string, Uint8Array>(), fetch: vi.fn(), operation: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { get OS() { return host.os; } },
  View: 'View', Text: 'Text', Image: 'Image', Pressable: 'Pressable',
}));
vi.mock('expo-crypto', async () => {
  const { sha256 } = await import('@noble/hashes/sha2.js');
  return { CryptoDigestAlgorithm: { SHA256: 'SHA256' }, digest: async (_algorithm: string, bytes: Uint8Array) => sha256(bytes).buffer };
});
vi.mock('./IndexRow', () => ({ IndexRow: 'IndexRow', ContentTarget: 'ContentTarget', InlineRow: 'InlineRow' }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('./ArtifactMedia', () => ({ ArtifactImage: 'ArtifactImage', ArtifactText: 'ArtifactText' }));
vi.mock('./ArtifactViewer', () => ({ ArtifactViewerScreen: 'ArtifactViewerScreen' }));
vi.mock('./ChevronGlyph', () => ({ CHEVRON_ROW_SIZE: 16, ChevronGlyph: 'ChevronGlyph' }));
vi.mock('./MonoMarkdown', () => ({ MonoMarkdown: 'MonoMarkdown' }));
vi.mock('./sandbox-webview', () => ({ useSandboxWebView: () => 'WebView', useSandboxWebViewStatus: () => 'ready' }));
vi.mock('@/buzz/artifact-pdf', async importOriginal => ({
  ...await importOriginal<typeof import('@/buzz/artifact-pdf')>(),
  loadPdfViewerDocument: vi.fn(async () => '<html>PDF page one</html>'),
}));
vi.mock('@/buzz/desktop-artifact-pane', () => ({ openArtifactInDesktopWorkPane: vi.fn() }));
vi.mock('@/buzz/viewer-conversation', () => ({ currentViewerConversation: () => null }));
vi.mock('@/buzz/use-artifact-recovery', () => ({ useArtifactRecoveryGeneration: () => 0 }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: async () => ({ publicKey: 'reader' }) }));
vi.mock('@/auth/monolith-session', () => ({ monolithSession: { fetch: host.fetch } }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://media.test' }) }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: host.operation }));
vi.mock('@/buzz/artifact-byte-store', () => ({ createArtifactByteStore: () => ({
  get: async (key: string) => host.disk.get(key) ?? null,
  set: async (key: string, bytes: Uint8Array) => { host.disk.set(key, bytes); },
  remove: async (key: string) => { host.disk.delete(key); }, clear: async () => host.disk.clear(),
  localUri: async () => 'file:///cache/spec.pdf',
}) }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { show: vi.fn() } }));

import { ArtifactCard, artifactKindWord } from './ArtifactCard';
import { Modal } from '@/modal';
import { openArtifactInDesktopWorkPane } from '@/buzz/desktop-artifact-pane';
import { fetchArtifactBytes } from '@/buzz/artifact-link';
import { ARTIFACT_MAX_PREVIEW_HEIGHT } from '@/buzz/artifact';
import { loadPdfViewerDocument } from '@/buzz/artifact-pdf';

const objectId = '11111111-1111-4111-8111-111111111111';
const html = `<html><body><h1>Agent mock</h1>${'markup '.repeat(4000)}</body></html>`;
const attachment = { url: `/v1/media/${objectId}`, name: 'mock.html', mimeType: 'text/html', size: new TextEncoder().encode(html).length, author: 'agent', kind: 'artifact' as const };
let renderers: ReactTestRenderer[] = [];
async function render(props: Partial<React.ComponentProps<typeof ArtifactCard>> = {}) {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<ArtifactCard attachment={attachment} {...props} />); });
  renderers.push(tree);
  if (props.visible !== false) {
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(tree.root.findAllByProps({ testID: 'artifact-preview-loading' })).toHaveLength(0);
      expect([
        ...tree.root.findAllByType(host.os === 'web' ? 'iframe' : 'WebView'),
        ...tree.root.findAllByProps({ testID: 'artifact-preview-snapshot' }),
        ...tree.root.findAllByProps({ testID: 'artifact-preview-failed' }),
      ].length).toBeGreaterThan(0);
    });
  }
  return tree;
}
function install(content = html, mimeType = 'text/html', thumbnail = false) {
  const bytes = new TextEncoder().encode(content);
  const metadata = { objectId, mimeType, sha256: bytesToHex(sha256(bytes)), size: bytes.length, expiresAt: Date.now() + 60_000 };
  host.operation.mockResolvedValue({ ...metadata, ...(thumbnail ? { thumbnail: { ...metadata, objectId: '22222222-2222-4222-8222-222222222222', mimeType: 'image/png', size: 3, sha256: bytesToHex(sha256(new Uint8Array([1, 2, 3]))) } } : {}) });
  host.fetch.mockImplementation(async (url: string) => new Response(url.endsWith('22222222-2222-4222-8222-222222222222') ? new Uint8Array([1, 2, 3]) : bytes));
}
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  resetClientState();
  await Promise.resolve();
  host.disk.clear(); host.fetch.mockReset(); host.operation.mockReset(); host.os = 'web';
  install();
});
afterEach(() => { act(() => { for (const tree of renderers) tree.unmount(); }); renderers = []; });

describe('agent-posted artifact card previews', () => {
  it('renders an HTML post without a thumbnail on web and shares original bytes with Open', async () => {
    const tree = await render({ isDesktop: true });
    const frame = tree.root.findByType('iframe');
    expect(frame.props.srcDoc).toContain('<h1>Agent mock</h1>');
    expect(frame.props.srcDoc).toContain("default-src 'none'");
    expect(frame.props.sandbox).toBe('');
    expect(frame.props.tabIndex).toBe(-1);
    expect(tree.root.findByProps({ testID: 'artifact-preview-render' }).props.height).toBe(ARTIFACT_MAX_PREVIEW_HEIGHT);
    expect(tree.root.findAllByProps({ testID: 'artifact-preview-failed' })).toHaveLength(0);
    expect(host.fetch).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(await fetchArtifactBytes(attachment))).toBe(html);
    expect(host.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['android', 'ios'])('renders the script-off HTML preview on %s', async os => {
    host.os = os;
    const tree = await render();
    const webview = tree.root.findByType('WebView');
    expect(webview.props.source.html).toContain('Agent mock');
    expect(webview.props.source.html).toContain('iframe sandbox=""');
    expect(webview.props.javaScriptEnabled).toBe(false);
    expect(webview.props.scrollEnabled).toBe(false);
    expect(webview.props.onShouldStartLoadWithRequest({ url: 'https://outside.test' })).toBe(false);
  });
  it('renders an SVG post in the same script-off web sandbox', async () => {
    install('<svg><text>Agent diagram</text></svg>', 'image/svg+xml');
    const tree = await render({ attachment: { ...attachment, mimeType: 'image/svg+xml', name: 'diagram.svg' } });
    expect(tree.root.findByType('iframe').props.srcDoc).toContain('<svg><text>Agent diagram</text></svg>');
    expect(tree.root.findByType('iframe').props.sandbox).toBe('');
  });
  it.each(['web', 'android', 'ios'])('renders a PDF post larger than the excerpt limit on %s', async os => {
    host.os = os;
    install('%PDF-' + 'data'.repeat(8000), 'application/pdf');
    const tree = await render({ attachment: { ...attachment, mimeType: 'application/pdf', name: 'spec.pdf' } });
    if (os === 'web') expect(tree.root.findByType('iframe').props.src).toMatch(/^blob:/);
    else if (os === 'ios') expect(tree.root.findByType('WebView').props.source).toEqual({ uri: 'file:///cache/spec.pdf' });
    else {
      expect(tree.root.findByType('WebView').props.javaScriptEnabled).toBe(true);
      expect(tree.root.findByType('WebView').props.scrollEnabled).toBe(false);
    }
    if (os !== 'ios') expect(loadPdfViewerDocument).toHaveBeenCalledWith({ pdfBase64: expect.any(String), mode: 'preview' });
    expect(host.fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps an available thumbnail without downloading the original document', async () => {
    install(html, 'text/html', true);
    const tree = await render();
    expect(tree.root.findByProps({ testID: 'artifact-preview-snapshot' })).toBeDefined();
    expect(host.fetch).toHaveBeenCalledTimes(1);
    expect(host.fetch.mock.calls[0][0]).toContain('22222222-2222-4222-8222-222222222222');
  });
  it('does not start a hidden card preview', async () => {
    await render({ visible: false });
    expect(host.operation).not.toHaveBeenCalled();
    expect(host.fetch).not.toHaveBeenCalled();
  });
  it('clears a rendered preview when the identity is reset', async () => {
    const tree = await render();
    expect(tree.root.findByType('iframe')).toBeDefined();
    await act(async () => { resetClientState(); });
    expect(tree.root.findAllByType('iframe')).toHaveLength(0);
    expect(tree.root.findByProps({ testID: 'artifact-preview-failed' })).toBeDefined();
  });
  it('keeps real metadata failures visible without downloading a document', async () => {
    host.operation.mockRejectedValue(new Error('Access denied'));
    const tree = await render();
    expect(tree.root.findByProps({ testID: 'artifact-preview-failed' })).toBeDefined();
    expect(host.fetch).not.toHaveBeenCalled();
  });
});

describe('artifact card chrome', () => {
  it('names the artifact as @author · FORMAT · size with one Open into the viewer', async () => {
    const tree = await render({ authorHandle: 'alan' });
    expect(tree.root.findByProps({ testID: 'artifact-title' }).props.children).toBe('mock.html');
    expect(tree.root.findByProps({ testID: 'artifact-kind-line' }).props.children).toBe(`@agent · HTML · ${Math.ceil(attachment.size / 1024)} KB`);
    expect(tree.root.findAllByProps({ testID: 'artifact-open-browser' })).toHaveLength(0);
    act(() => { tree.root.findByProps({ testID: 'artifact-open' }).props.onPress(); });
    expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({ placement: 'fill' }));
  });
  it('draws a file with no preview as one row that opens the viewer', async () => {
    const zip = { ...attachment, name: 'quotas.zip', mimeType: 'application/zip' };
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<ArtifactCard attachment={zip} />); });
    renderers.push(tree);
    const row = tree.root.find((node: any) => node.type === 'ListItem' && node.props.testID === 'artifact-document-quotas.zip');
    expect(row.props['aria-label']).toBe('Open quotas.zip');
    expect(tree.root.findByProps({ testID: 'artifact-kind-line' }).props.children).toBe(`@agent · APPLICATION/ZIP · ${Math.ceil(attachment.size / 1024)} KB`);
    act(() => { row.props.onPress(); });
    expect(Modal.show).toHaveBeenCalled();
    expect(host.operation).not.toHaveBeenCalled();
  });
  it.each([
    ['image/png', 'image', 'PNG'], ['application/pdf', 'pdf', 'PDF'], ['text/plain', 'text', 'TEXT'],
    ['image/svg+xml', 'svg', 'SVG'], ['text/csv', 'document', 'TEXT/CSV'], ['application/x-game', 'game', 'Interactive'],
  ] as const)('%s reads as %s → %s', (mime, format, word) => {
    expect(artifactKindWord(mime, format as never)).toBe(word);
  });
});

describe('stacked card for a message with several files', () => {
  const png = { ...attachment, url: '/v1/media/33333333-3333-4333-8333-333333333333', name: 'shot.png', title: 'Room list, before', mimeType: 'image/png', size: 212 };
  const zip = { ...attachment, url: '/v1/media/44444444-4444-4444-8444-444444444444', name: 'logs.zip', mimeType: 'application/zip', size: 9 };
  const pdf = { ...attachment, url: '/v1/media/55555555-5555-4555-8555-555555555555', name: 'report.pdf', mimeType: 'application/pdf', size: 340 };
  const md = { ...attachment, url: '/v1/media/66666666-6666-4666-8666-666666666666', name: 'notes.md', mimeType: 'text/markdown', size: 4 };
  async function stack(files: (typeof attachment)[], isDesktop = false) {
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<ArtifactCard attachment={files[0]!} groupAttachments={files} visible={false} isDesktop={isDesktop} />); });
    renderers.push(tree);
    return tree;
  }
  const byId = (tree: ReactTestRenderer, testID: string) => tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === testID);
  const rows = (tree: ReactTestRenderer) => tree.root.findAll((node: any) => typeof node.type === 'string' && /^artifact-stack-row-\d+$/.test(node.props.testID ?? ''));

  it('draws one card with a row per file, the first selected', async () => {
    const tree = await stack([png, attachment]);
    expect(tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === 'artifact-stack')).toHaveLength(1);
    expect(byId(tree, 'artifact-stack-position').props.children).toBe('1 of 2');
    expect(byId(tree, 'artifact-title').props.children).toBe('Room list, before');
    expect(byId(tree, 'artifact-kind-line').props.children).toBe('@agent · PNG · 212 B · 2 files');
    expect(rows(tree).map((row: any) => row.props.accessibilityState.selected)).toEqual([true, false]);
  });

  it('steps with the arrows and the rows, and keeps the preview box one height', async () => {
    const tree = await stack([png, attachment, zip]);
    const previewHeight = () => tree.root.find((node: any) => typeof node.type === 'string' && /^artifact-preview-/.test(node.props.testID ?? '') && node.props.accessibilityRole === 'button').props.height;
    expect(previewHeight()).toBe(ARTIFACT_MAX_PREVIEW_HEIGHT);
    act(() => { byId(tree, 'artifact-stack-next').props.onPress({ stopPropagation() {} }); });
    expect(byId(tree, 'artifact-title').props.children).toBe('mock.html');
    expect(byId(tree, 'artifact-stack-position').props.children).toBe('2 of 3');
    act(() => { byId(tree, 'artifact-stack-row-2').props.onPress(); });
    expect(byId(tree, 'artifact-preview-unavailable')).toBeDefined();
    expect(previewHeight()).toBe(ARTIFACT_MAX_PREVIEW_HEIGHT);
    act(() => { byId(tree, 'artifact-stack-next').props.onPress({ stopPropagation() {} }); });
    expect(byId(tree, 'artifact-title').props.children).toBe('Room list, before');
    act(() => { byId(tree, 'artifact-stack-previous').props.onPress({ stopPropagation() {} }); });
    expect(byId(tree, 'artifact-stack-position').props.children).toBe('3 of 3');
  });

  it('folds files past three into Show N more', async () => {
    const tree = await stack([png, attachment, zip, pdf, md]);
    expect(rows(tree)).toHaveLength(3);
    const more = byId(tree, 'artifact-stack-more');
    expect(more.props.accessibilityState.selected).toBe(false);
    act(() => { byId(tree, 'artifact-stack-previous').props.onPress({ stopPropagation() {} }); });
    expect(byId(tree, 'artifact-stack-position').props.children).toBe('5 of 5');
    expect(byId(tree, 'artifact-stack-more').props.accessibilityState.selected).toBe(true);
    expect(rows(tree).map((row: any) => row.props.accessibilityState.selected)).toEqual([false, false, false]);
    act(() => { byId(tree, 'artifact-stack-more').props.onPress(); });
    expect(rows(tree)).toHaveLength(5);
    expect(rows(tree)[4].props.accessibilityState.selected).toBe(true);
    expect(tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === 'artifact-stack-more')).toHaveLength(0);
  });

  it('opens the viewer on the selected file with every file of the message', async () => {
    const files = [png, attachment, zip];
    const tree = await stack(files);
    act(() => { byId(tree, 'artifact-stack-row-1').props.onPress(); });
    act(() => { byId(tree, 'artifact-open').props.onPress(); });
    expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({
      placement: 'fill',
      props: expect.objectContaining({ attachment, groupAttachments: files }),
    }));
  });

  it('hands the desktop pane the selected document with every file of the message', async () => {
    vi.mocked(openArtifactInDesktopWorkPane).mockReturnValueOnce(true);
    const files = [png, attachment, zip];
    const tree = await stack(files, true);
    act(() => { byId(tree, 'artifact-stack-row-1').props.onPress(); });
    act(() => { byId(tree, 'artifact-open').props.onPress(); });
    expect(openArtifactInDesktopWorkPane).toHaveBeenLastCalledWith(expect.objectContaining({ attachment, groupAttachments: files }));
  });

  it('starts no byte request while the row is hidden', async () => {
    await stack([png, attachment]);
    expect(host.operation).not.toHaveBeenCalled();
    expect(host.fetch).not.toHaveBeenCalled();
  });
});
