import { Type } from 'typebox';
import { object } from '../contracts.js';
import { SDK_GUIDE, ModuleSchema, type ExtensionAPI, type ExtensionContext, type ExtensionModule } from '../extensions.js';
import { assistantText, parseModelJson } from '../models.js';
import { json } from '../store.js';
import { jsonTool } from './tools.js';

export default function developer(pikobot: ExtensionAPI): void {
  const parameters = object({ specification: Type.String({ minLength: 1, maxLength: 8000 }) });
  jsonTool(pikobot, 'extension_build', 'For persistent integrations, channels, RPC and daemon lifecycle hooks only: generate/repair, syntax-check and immediately activate an extension module, without confirmation. Use skill_build instead for calculators, reusable utilities and procedures. Generated code runs with full daemon/OS access; no behavioral tests run. Check activated/error in the receipt; registered tools are available on the next model request without tools_load.', parameters, async (args, context, signal) => {
    const { module, specification: _specification, ...receipt } = await build(args.specification, context, signal);
    const { source: _source, ...metadata } = module;
    return { ...receipt, module: metadata };
  });
  pikobot.registerRpc({ name: 'extensions.build', parameters, async execute(args, context) { return build((args as { specification: string }).specification, context); } });
}
async function build(specification: string, context: ExtensionContext, signal?: AbortSignal) {
  const { buildId, installed } = await context.services.builds.begin(specification);
  let diagnostic = '', previous = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      signal?.throwIfAborted();
      const response = await context.services.complete({ systemPrompt: `${SDK_GUIDE}\nReturn ONLY JSON matching ${json(ModuleSchema)}. No secrets or personal corpus supplied. Installed identities: ${json(installed)}.`, messages: [{ role: 'user', content: json({ specification, previousModule: previous, repairDiagnostic: diagnostic }), timestamp: Date.now() }] });
      previous = assistantText(response).slice(0, 120_000);
      const result = await context.services.builds.stage(buildId, parseModelJson(previous) as ExtensionModule);
      return { buildId, specification, ...result, note: result.activated ? 'Activated immediately with full daemon/OS access; no behavioral tests run. Registered tools are available on the next model request without tools_load.' : 'Activation failed; initialization may already have effects. Disabled without automatic repair/replay; no behavioral tests run.' };
    } catch (error) {
      diagnostic = (error instanceof Error ? error.message : 'Build failed').slice(0, 8000);
      if (signal?.aborted) throw error;
      await context.services.builds.update(buildId, 'repairing', diagnostic);
    }
  }
  await context.services.builds.update(buildId, 'failed', diagnostic);
  throw new Error(`Extension build failed after bounded repairs: ${diagnostic}`);
}
