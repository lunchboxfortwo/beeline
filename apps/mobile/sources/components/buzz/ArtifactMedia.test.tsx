import React from 'react';
import { ArtifactByteError } from '@/buzz/artifact-byte-error';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  image: vi.fn(), text: vi.fn(), release: vi.fn(), recovery: 0,
  purge: undefined as (() => void) | undefined,
}));
vi.mock('react-native', () => ({ Image: 'Image', ScrollView: 'ScrollView', Text: 'Text', View: 'View' }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-reanimated', () => ({ default: { View: 'AnimatedView' } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('./IndexRow', () => ({ IndexRow: 'IndexRow' }));
vi.mock('@/buzz/use-artifact-recovery', () => ({ useArtifactRecoveryGeneration: () => host.recovery }));
vi.mock('@/buzz/artifact-link', () => ({
  artifactImageSource: host.image, fetchArtifactText: host.text, releaseArtifactImageSource: host.release,
  subscribeArtifactBytesPurge: (_attachment: unknown, listener: () => void) => {
    host.purge = listener;
    return () => { host.purge = undefined; };
  },
}));
import { ArtifactImage, ArtifactText } from './ArtifactMedia';
const attachment = { url: '/v1/media/11111111-1111-4111-8111-111111111111', name: 'Citrus', mimeType: 'image/jpeg', size: 1022645 };
let tree: ReactTestRenderer | undefined;
beforeEach(() => { vi.resetAllMocks(); host.recovery = 0; host.purge = undefined; });
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; });

// Fresh server DTOs and connection notifications are not new file demand.
// They must not cancel a download that is slower than transcript updates.
describe.each(['image', 'text'] as const)('%s byte demand', kind => {
  const render = (file = attachment) => kind === 'image'
    ? <ArtifactImage attachment={file} fit="cover" testID="loaded" />
    : <ArtifactText attachment={file} crop testID="loaded" />;
  const read = () => kind === 'image' ? host.image : host.text;
  it('finishes the original read across equivalent DTOs and socket recovery without refetching', async () => {
    let complete!: (value: any) => void;
    read().mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    await act(async () => { tree = create(render()); });
    if (kind === 'image') {
      const placeholder = tree!.root.findByProps({ testID: 'artifact-image-loading' });
      // A growing/padded View consumes the filename column in a compact row:
      // the placeholder fills the caller's frame and nothing more.
      expect(placeholder.props).toMatchObject({ width: '100%', height: '100%' });
      expect(placeholder.props.flex).toBeUndefined();
      expect(placeholder.props.padding).toBeUndefined();
    }
    const signal = read().mock.calls[0][1].signal as AbortSignal;
    for (let n = 0; n < 6; n++) {
      host.recovery++;
      await act(async () => tree!.update(render({ ...attachment })));
    }
    expect(signal.aborted).toBe(false);
    expect(read()).toHaveBeenCalledTimes(1);
    await act(async () => complete(kind === 'image' ? { uri: 'blob:one' } : 'File contents'));
    expect(tree!.root.findAllByProps({ testID: `artifact-${kind}-loading` })).toHaveLength(0);
    expect(tree!.root.findByProps({ testID: 'loaded' })).toBeDefined();
    host.recovery++;
    await act(async () => tree!.update(render({ ...attachment })));
    expect(read()).toHaveBeenCalledTimes(1);
  });
  it('settles a byte failure, ignores redraws, and rereads once after confirmed recovery', async () => {
    read().mockRejectedValue(new ArtifactByteError(new Error('The file failed its immutable integrity check.')));
    await act(async () => { tree = create(render()); });
    expect(tree!.root.findAllByProps({ testID: `artifact-${kind}-loading` })).toHaveLength(0);
    expect(tree!.root.findByProps({ testID: `artifact-${kind}-failed` })).toBeDefined();
    await act(async () => tree!.update(render({ ...attachment })));
    expect(read()).toHaveBeenCalledTimes(1);
    host.recovery++;
    await act(async () => tree!.update(render({ ...attachment })));
    expect(read()).toHaveBeenCalledTimes(2);
    expect(tree!.root.findByProps({ testID: `artifact-${kind}-failed` })).toBeDefined();
    for (let n = 0; n < 6; n++) {
      host.recovery++;
      await act(async () => tree!.update(render({ ...attachment })));
    }
    expect(read()).toHaveBeenCalledTimes(2);
  });
  it('cancels when the actual file changes and ignores the old result', async () => {
    let old!: (value: any) => void;
    read().mockImplementationOnce(() => new Promise(resolve => { old = resolve; }))
      .mockResolvedValueOnce(kind === 'image' ? { uri: 'blob:new' } : 'New contents');
    await act(async () => { tree = create(render()); });
    const signal = read().mock.calls[0][1].signal as AbortSignal;
    await act(async () => tree!.update(render({ ...attachment, url: '/v1/media/22222222-2222-4222-8222-222222222222' })));
    expect(signal.aborted).toBe(true);
    await act(async () => old(kind === 'image' ? { uri: 'blob:old' } : 'Old contents'));
    if (kind === 'image') {
      expect(tree!.root.findByType('Image').props.source.uri).toBe('blob:new');
      expect(host.release).toHaveBeenCalledWith({ uri: 'blob:old' });
    }
    expect(read()).toHaveBeenCalledTimes(2);
  });
  it('purges private bytes without admitting a replacement read', async () => {
    read().mockResolvedValue(kind === 'image' ? { uri: 'blob:private' } : 'Private contents');
    await act(async () => { tree = create(render()); });
    await act(async () => host.purge!());
    expect(tree!.root.findByProps({ testID: `artifact-${kind}-failed` })).toBeDefined();
    host.recovery++;
    await act(async () => tree!.update(render({ ...attachment })));
    expect(read()).toHaveBeenCalledTimes(1);
  });
});
