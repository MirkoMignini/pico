import type { TSchema } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '../extensions.js';
import { json } from '../store.js';
import type { ToolHistoryPolicy } from '../tool-context.js';

export function jsonTool(api: ExtensionAPI, name: string, description: string, parameters: TSchema,
  execute: (args: Record<string, any>, context: ExtensionContext, signal?: AbortSignal) => Promise<unknown>,history?:ToolHistoryPolicy): void {
  api.registerTool({ name, label: name, description, parameters,...(history===undefined?{}:{history}),
    execute: async (_callId, args, signal, _update, context) => ({ content: [{ type: 'text', text: json(await execute(args as Record<string, any>, context, signal)) }], details: undefined }) });
}
