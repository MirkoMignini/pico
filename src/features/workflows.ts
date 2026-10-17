import { Type } from 'typebox';
import { object } from '../contracts.js';
import { workflowSchema } from '../workflows.js';
import type { ExtensionAPI } from '../extensions.js';
import type { Runtime } from '../runtime.js';
import { jsonTool } from './tools.js';

export default function workflows(pico: ExtensionAPI, core: Runtime): void {
  jsonTool(pico, 'workflows_list', 'List owner-defined bounded workflows; no capability changes.', object({}), async () => core.workflows.list());
  jsonTool(pico, 'workflow_run', 'Run up to eight validated named tools under the current authenticated permissions and shared call budget. No recursion or code generation; writes require trusted retained foreground work.', object({ id: Type.String() }), async (args, context, signal) => {
    const definition = core.workflows.read(args.id), results = [];
    for (const step of definition.steps) { signal?.throwIfAborted(); results.push(await context.callTool(step.tool, step.args)); }
    return results;
  });
  pico.registerRpc({ name: 'workflows.list', parameters: object({}), async execute() { return core.workflows.list(); } });
  pico.registerRpc({ name: 'workflows.define', parameters: workflowSchema, async execute(args, context) { return core.workflows.define(args, core.availableTools(context)); } });
  pico.registerRpc({ name: 'workflows.enable', parameters: object({ id: Type.String(), enabled: Type.Boolean() }), async execute(args) { const a = args as { id: string; enabled: boolean }; core.workflows.enable(a.id, a.enabled); return { ok: true }; } });
  pico.registerRpc({ name: 'workflows.rollback', parameters: object({ id: Type.String(), version: Type.Integer({ minimum: 1 }) }), async execute(args, context) { const a = args as { id: string; version: number }; return core.workflows.rollback(a.id, a.version, core.availableTools(context)); } });
}
