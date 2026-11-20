import Schema from '@deepseek-ai/schemastery';
import { defineTool, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools';
import { CacheClient } from './client.js';
import { Rollouts } from './rollouts.js';

export const name = 'dsh-layercache';
export const inject = ['tools'];
export const Config = Schema.object({
  endpoint: Schema.string().default('http://127.0.0.1:8088').description('Existing LayerCache service origin'),
  backend: Schema.union(['layerfs', 'local']).default('layerfs').description('Required service backend; local is an explicit reference mode'),
  tokenEnv: Schema.string().default('LAYERCACHE_TOKEN').description('Environment variable containing the service Bearer token'),
  requestTimeoutMs: Schema.natural().min(1).default(120000),
  maxRollouts: Schema.natural().min(1).default(1024).description('Maximum rollout labels, including closed/failed labels, per plugin lifetime'),
  allowedTools: Schema.array(Schema.string()).default(['file.write', 'file.append', 'file.read']).description('Service tool allowlist; add shell only for trusted command execution'),
});

function owner(exec) {
  const id = exec.agent?.session?.header?.id;
  if (!id) throw new ToolContextUnavailableError('TVCache tools require an owning dsh agent session');
  return id;
}

/** Register explicit full-history cache tools using dsh's ordinary policy pipeline. */
export async function apply(ctx, config) {
  const client = new CacheClient(config);
  await client.check(config.backend);
  const rollouts = new Rollouts(client, config);
  ctx.effect(() => () => rollouts.dispose(), 'dsh-layercache: drain and close rollouts');
  ctx.tools.register(defineTool({
    name: 'tvcache_run',
    description: 'Execute a complete, append-only tool history in a LayerFS rollout. Use the same task_id across equivalent rollouts, a distinct rollout label for each trajectory, and cache:false for external effects. Paths are absolute inside the cached filesystem, separate from the dsh workspace. Close the label with tvcache_close when finished. Failed/closed labels cannot restart automatically.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Stable dataset/sample identity; change it when inputs change' },
      rollout: { type: 'string', required: true, description: 'Trajectory label owned by the calling dsh session' },
      history: { type: 'array', required: true, items: {
        type: 'object', additionalProperties: false, properties: {
          name: { type: 'string', required: true, description: `Allowed service tools: ${config.allowedTools.join(', ')}` },
          arguments: { type: 'object', additionalProperties: true },
          cache: { type: 'boolean', description: 'false disables reuse from this call onward' },
        },
      } },
      candidate_tools: { type: 'array', items: { type: 'string' }, description: 'Tools expected for this task, scanned before the first invocation' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        task_id: { type: 'string', required: true }, rollout: { type: 'string', required: true },
        value: { type: 'json', required: true }, ref: { type: 'string', required: true },
        executed: { type: 'integer', required: true }, cache_hits: { type: 'integer', required: true }, continued: { type: 'integer', required: true },
        steps: { type: 'array', required: true, items: {
          type: 'object', additionalProperties: false, properties: {
            hit: { type: 'boolean', required: true }, source: { type: 'string', required: true },
            publication: { type: 'string' }, revision: { type: 'string' }, generation: { type: 'integer' }
          }
        } },
        unknown_tools: { type: 'array', required: true, items: { type: 'string' } },
        preflight: { type: 'json', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, { task_id, rollout, ref, executed, cache_hits, continued, unknown_tools }) => ({ task_id, rollout, ref, executed, cache_hits, continued, unknown_tools }),
    },
    presentCall: args => ({ card: 'generic', kind: 'execute', title: `TVCache: ${args.task_id} / ${args.rollout}`, rawInput: args.history }),
    presentResult: (_args, result) => result.meta?.cache_hits === undefined ? undefined : ({ card: 'generic', title: `TVCache: ${result.meta.cache_hits} hits, ${result.meta.executed} executed` }),
    execute: (args, exec) => rollouts.run(owner(exec), args, exec.signal),
  }));
  ctx.tools.register(defineTool({
    name: 'tvcache_prepare',
    description: 'Preflight the candidate tool list for a task before creating rollout executions. Unregistered names are reported as unknown and actual calls still require registered implementations.',
    parameters: {
      task_id: { type: 'string', required: true },
      candidate_tools: { type: 'array', required: true, items: { type: 'string' } },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args, exec) => client.prepare(args.task_id, args.candidate_tools, exec.signal),
  }));
  ctx.tools.register(defineTool({
    name: 'tvcache_close',
    description: 'Close a TVCache rollout owned by this dsh session after its calls finish. The label remains closed; choose a new label deliberately for a new trajectory.',
    parameters: { rollout: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { rollout: { type: 'string', required: true }, closed: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args, exec) => rollouts.close(owner(exec), args.rollout, exec.signal),
  }));
}
