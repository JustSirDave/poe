import { describe, expect, it } from 'vitest';
import { createMcpHandler } from './mcp';
import { CoachService } from './service';
import { resolveConfig } from './config';
import { analyzeEfficiency } from './analysis';
describe('read-only MCP adapter', () => {
  it('negotiates a supported version and exposes only bounded read tools', async () => {
    const service = new CoachService(resolveConfig({}, process.cwd()));
    service.report = analyzeEfficiency([], service.config);
    const handle = createMcpHandler(service);
    expect(await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toHaveProperty('error');
    expect(await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: 'future' } })).toHaveProperty('result.protocolVersion', '2025-06-18');
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    const result = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) as { result: { tools: { annotations: { readOnlyHint: boolean } }[] } };
    expect(result.result.tools).toHaveLength(3);
    expect(result.result.tools.every(tool => tool.annotations.readOnlyHint)).toBe(true);
    expect(await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'coach_findings', arguments: { limit: 5000 } } })).toHaveProperty('result.isError', true);
    expect(await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'coach_summary', arguments: {} } })).toHaveProperty('result.content');
    expect(await handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'install_skill' } })).toHaveProperty('error.code', -32602);
  });
});
