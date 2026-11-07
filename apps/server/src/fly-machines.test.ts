import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlyApiError, FlyMachines } from './fly-machines.js';

afterEach(() => vi.useRealTimers());

describe('Fly start during suspend', () => {
  it('Klor: 34.293 seconds preparing an image still launches without a timed wait', async () => {
    vi.useFakeTimers();
    let state = 'stopped';
    const requests: string[] = [];
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url).split('/machines/m1')[1]!;
      requests.push(`${init?.method} ${path}`);
      if (!path && init?.method === 'GET') return Response.json({ state, instance_id: 'old', config: { image: 'old', rootfs: { persist: 'always' } } });
      if (!path && init?.method === 'POST') {
        const update = JSON.parse(String(init.body));
        state = 'replacing';
        setTimeout(() => { state = update.skip_launch ? 'stopped' : 'started'; }, 34_293);
        return Response.json({ instance_id: 'new' });
      }
      if (path.startsWith('/wait')) return new Response('{}', { status: 408 });
      if (path === '/start') state = 'started';
      return Response.json({});
    });
    await new FlyMachines('synthetic', 'proof', request).start('m1', 'new');
    await vi.advanceTimersByTimeAsync(34_293);
    expect(state).toBe('started');
    expect(requests).toEqual(['GET ', 'POST ']);
  });

  it('boots the new image during refresh, suspends the ready helper, and resumes on the next wake', async () => {
    let state = 'suspended';
    let version = 'old-version';
    let config = { image: 'old', env: { keep: 'value' }, rootfs: { persist: 'always' } };
    const starts: string[] = [];
    const request = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const path = String(url).split('/machines/m1')[1]!;
      if (!path && init?.method === 'GET') return Response.json({ state, instance_id: version, config });
      if (!path && init?.method === 'POST') {
        const update = JSON.parse(String(init.body));
        expect(update.current_version).toBe(version);
        expect(update.skip_launch).toBe(false);
        config = update.config;
        version = 'new-version';
        state = 'started';
        return Response.json({ instance_id: version });
      }
      if (path === '/wait?state=stopped&timeout=30&instance_id=new-version') state = 'stopped';
      if (path === '/stop') state = 'stopped';
      if (path === '/start') { starts.push(state); state = 'started'; }
      if (path === '/suspend') state = 'suspended';
      return Response.json({});
    });
    const machines = new FlyMachines('test', 'proof', request);
    expect(await machines.refresh('m1', 'new')).toBe(true);
    expect(config).toEqual({ image: 'new', env: { keep: 'value' }, rootfs: { persist: 'always' } });
    expect(state).toBe('started');
    // The new helper has connected and reached its existing idle boundary.
    expect(await machines.refresh('m1', 'new')).toBe(false);
    await machines.suspend('m1');
    await machines.waitFor('m1', 'suspended', 60);
    expect(state).toBe('suspended');
    await machines.start('m1', 'new');
    expect(starts).toEqual(['suspended']);
  });

  it('keeps the baked helper when its pinned image is already serving', async () => {
    const request=vi.fn<typeof fetch>().mockResolvedValue(Response.json({state:'started',config:{image:'same'}}));
    expect(await new FlyMachines('test','proof',request).refresh('m1','same',true)).toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });

  it('updates a stale image before wake, preserving the complete Machine configuration', async () => {
    const config = { image: 'old', env: { bootstrap: 'one-time' }, rootfs: { persist: 'always' },
      metadata: { beeline_agent: 'same-agent' }, guest: { cpus: 1, memory_mb: 2048 } };
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      state: 'suspended', instance_id: 'current-version', config,
    }))).mockImplementation(async (url, init) => Response.json(
      String(url).endsWith('/m1') && init?.method === 'POST' ? { instance_id: 'replacement-version' } : {}));
    await new FlyMachines('test', 'proof', request).start('m1', 'new');
    expect(request.mock.calls.map(([url]) => String(url).split('/machines')[1])).toEqual([
      '/m1', '/m1',
    ]);
    expect(JSON.parse(String(request.mock.calls[1]![1]!.body))).toEqual({
      current_version: 'current-version', skip_launch: false, config: { ...config, image: 'new' },
    });
  });

  it('does not update a current digest under a different tag', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      state: 'stopped', config: { image: 'registry/image:old-tag@sha256:same' },
    }))).mockResolvedValue(new Response('{}'));
    await new FlyMachines('test', 'proof', request).start('m1', 'registry/image:new-tag@sha256:same');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('never starts after a failed image update', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      state: 'stopped', version: 'v1', config: { image: 'old' },
    }))).mockResolvedValueOnce(new Response('{}', { status: 500 }));
    await expect(new FlyMachines('test', 'proof', request).start('m1', 'new')).rejects.toMatchObject({ operation: 'update image' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('lets the provider launch an accepted replacement without waiting for stopped', async () => {
    const request=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({state:'stopped',instance_id:'old',config:{image:'old'}}))
      .mockResolvedValueOnce(Response.json({instance_id:'replacement',state:'replacing'}));
    await new FlyMachines('test','proof',request).start('m1','new');
    expect(request.mock.calls.map(([url])=>String(url).split('/machines')[1])).toEqual(['/m1','/m1']);
  });
  it('returns a snapshot transition refusal without a timed reattempt', async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"error":"machine still active"}', { status: 412 }))
      .mockResolvedValueOnce(new Response('{}'));
    const machines = new FlyMachines('test', 'proof', request);
    await expect(machines.start('m1')).rejects.toMatchObject({ status: 412, operation: 'start' });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    // A separate caller action can address the same Machine.
    await machines.start('m1');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([url]) => String(url).endsWith('/machines/m1/start'))).toBe(true);
  });

  it('preserves an uncertain lost response without resubmitting the start', async () => {
    vi.useFakeTimers();
    const error = new TypeError('response lost after acceptance');
    const request = vi.fn<typeof fetch>().mockRejectedValue(error);
    await expect(new FlyMachines('test', 'proof', request).start('m1')).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 404, 429, 500])(
    'does not turn HTTP %i into a suspend retry',
    async (status) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status }));
      await expect(new FlyMachines('test', 'proof', request).start('m1')).rejects.toBeInstanceOf(
        FlyApiError,
      );
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
});
