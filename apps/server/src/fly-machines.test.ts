import { expect, it, vi } from 'vitest';
import { FlyApiError, FlyMachines, sameMachineImage } from './fly-machines.js';

it('replaces the full config at the observed version without inventing launch completion',async()=>{
  const machine={id:'m1',state:'stopped',instance_id:'old',config:{image:'old',env:{keep:'saved'},rootfs:{persist:'always'}}};
  const request=vi.fn<typeof fetch>().mockResolvedValue(Response.json({...machine,state:'replacing',instance_id:'new'}));
  await new FlyMachines('fixture','lab',request).update(machine,'new-image');
  expect(request).toHaveBeenCalledOnce();
  expect(JSON.parse(String(request.mock.calls[0]![1]!.body))).toEqual({current_version:'old',skip_launch:false,
    config:{...machine.config,image:'new-image',init:{kernel_args:['acpi=force']}}});
});
it('binds the provider completion observation to the replacement instance',async()=>{
  const request=vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
  await new FlyMachines('fixture','lab',request).waitFor('m1','stopped',60,'new-version');
  expect(String(request.mock.calls[0]![0])).toContain('/m1/wait?state=stopped&timeout=60&instance_id=new-version');
});
it.each([412,500])('returns HTTP %s without resubmitting an effect',async status=>{
  const request=vi.fn<typeof fetch>().mockResolvedValue(new Response('refused',{status}));
  await expect(new FlyMachines('fixture','lab',request).start('m1')).rejects.toBeInstanceOf(FlyApiError);
  expect(request).toHaveBeenCalledOnce();
});
it('keeps transport loss unknown without retry',async()=>{
  const request=vi.fn<typeof fetch>().mockRejectedValue(new TypeError('lost reply'));
  await expect(new FlyMachines('fixture','lab',request).start('m1')).rejects.toThrow('lost reply');
  expect(request).toHaveBeenCalledOnce();
});
it('treats identical digests under different tags as the same image',()=>{
  expect(sameMachineImage('image:old@sha256:same','image:new@sha256:same')).toBe(true);
  expect(sameMachineImage('image:old@sha256:other','image:new@sha256:same')).toBe(false);
});
it('exposes the native VMGenID resume event on new free-agent machines',async()=>{
  const request=vi.fn<typeof fetch>().mockResolvedValue(Response.json({id:'new-machine'}));
  await new FlyMachines('fixture','lab',request).create({agentId:'agent',image:'image',region:'iad',env:{},cpus:1,memoryMb:2048});
  expect(JSON.parse(String(request.mock.calls[0]![1]!.body)).config.init.kernel_args).toContain('acpi=force');
});
it('enables resume events when replacing an existing image without dropping its boot configuration',async()=>{
  const machine={id:'m1',state:'suspended',instance_id:'old',config:{image:'old',init:{exec:['/entrypoint'],kernel_args:['quiet','acpi=off']}}};
  const request=vi.fn<typeof fetch>().mockResolvedValue(Response.json({...machine,instance_id:'new'}));
  await new FlyMachines('fixture','lab',request).update(machine,'new-image');
  expect(JSON.parse(String(request.mock.calls[0]![1]!.body)).config.init).toEqual({exec:['/entrypoint'],kernel_args:['quiet','acpi=force']});
});
