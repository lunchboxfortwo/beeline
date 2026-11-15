import { expect, it } from 'vitest';
import { squireApprovalCall, squireApprovalSchemas } from './squire-approval-intent.js';
import { squireApprovalFromMcp } from './resource-mcp-facade.js';
it('advertises required bounded intent for approval tools, preserving other tools', () => {
  const read = { name: 'list_credentials', inputSchema: { type: 'object' } };
  const response = squireApprovalSchemas({ result: { tools: [{ name: 'inject_card', inputSchema: { type: 'object', required: ['item'], properties: { item: { type: 'string' } } } }, read] } }) as any;
  expect(response.result.tools[0].inputSchema.required).toEqual(['item', 'action', 'purpose']);
  expect(response.result.tools[0].inputSchema.properties.action.maxLength).toBe(120);
  expect(response.result.tools[0].inputSchema.properties.purpose.maxLength).toBe(240);
  expect(response.result.tools[1]).toBe(read);
});
it('refuses missing or long intent before the upstream call', () => {
  for (const args of [{}, { action: 'Connect Link' }, { action: 'word '.repeat(13), purpose: 'renew the domain' }]) {
    expect(() => squireApprovalCall({ method: 'tools/call', params: { name: 'connect', arguments: args } })).toThrow(/Supply|Shorten/);
  }
});
it('retains intent for the chat relay while keeping upstream arguments compatible', () => {
  const request = { id: 1, method: 'tools/call', params: { name: 'inject_card', arguments: { item: 'Domain renewal',
    action: 'Pay Whitejade $29', purpose: 'renew whitejade.xyz' } } };
  expect((squireApprovalCall(request).params as any).arguments).toEqual({ item: 'Domain renewal' });
  expect(request.params.arguments.purpose).toBe('renew whitejade.xyz');
  const card = squireApprovalFromMcp(request, { id: 1, result: { approval_url: 'https://trustysquire.test/approval/a' } });
  expect(card).toMatchObject({ action: 'Pay Whitejade $29', purpose: 'renew whitejade.xyz' });
});
