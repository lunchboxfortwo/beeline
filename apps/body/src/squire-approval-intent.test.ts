import { expect, it } from 'vitest';
import { squireApprovalCall, squireApprovalSchemas } from './squire-approval-intent.js';
import { squireApprovalFromMcp } from './resource-mcp-facade.js';
it.each(['connect', 'fetch_credential', 'inject_card', 'edit_credential', 'delete_credential',
  'edit_payment_card', 'operate_login', 'operate_fill_credential', 'operate',
  'operate_start', 'operate_navigate', 'operate_drive'])('advertises optional bounded intent for %s, preserving other tools', name => {
  const read = { name: 'list_credentials', inputSchema: { type: 'object' } };
  const response = squireApprovalSchemas({ result: { tools: [{ name, inputSchema: { type: 'object', required: ['item'], properties: { item: { type: 'string' } } } }, read] } }) as any;
  expect(response.result.tools[0].inputSchema.required).toEqual(['item']);
  expect(response.result.tools[0].inputSchema.properties.action.maxLength).toBe(120);
  expect(response.result.tools[0].inputSchema.properties.purpose.maxLength).toBe(240);
  expect(response.result.tools[1]).toBe(read);
});
it('forwards calls with missing, partial or long intent', () => {
  for (const args of [{}, { action: 'Connect Link' }, { action: 'word '.repeat(13), purpose: 'renew the domain' }]) {
    expect(squireApprovalCall({ method: 'tools/call', params: { name: 'connect', arguments: args } })).toMatchObject({ params: { arguments: {} } });
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
