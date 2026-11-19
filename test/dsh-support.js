import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as Native from '@deepseek-ai/dsh-tool-executor-native';
import * as Plugin from '../plugin/index.js';

export async function mount(endpoint, config = {}) {
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(Tools);
    await ctx.plugin(Native);
    const fork = await ctx.plugin(Plugin, { endpoint, backend: 'local', ...config });
    assert.ok(ctx.tools.get('tvcache_run'), 'plugin must load, not only return a failed fork');
    return { ctx, fork };
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}
export function caller(id) { return { session: { header: { id } } }; }
export async function invoke(ctx, agent, name, args) {
  const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }], agent, signal: new AbortController().signal });
  const result = batch.results[0].result;
  return { result, value: result.isError ? null : JSON.parse(result.content[0].text) };
}
