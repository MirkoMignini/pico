import type { AssistantMessage } from '@earendil-works/pi-ai';
import { Type, type Static } from 'typebox';
import { object } from './contracts.js';
import type { ScheduleDefinition } from './contracts.js';
import type { ExtensionModule } from './extensions.js';

export const CompletionSchema = object({ maxTokens: Type.Optional(Type.Integer({ minimum: 256, maximum: 16_384 })), systemPrompt: Type.Optional(Type.String({ maxLength: 120_000 })), messages: Type.Array(object({ role: Type.Literal('user'), content: Type.String({ maxLength: 200_000 }), timestamp: Type.Number({ minimum: 0 }) }), { minItems: 1, maxItems: 8 }) });

/** These callbacks are bound to the authenticated execution, never a caller-supplied owner. */
export interface ExtensionServices {
  documents(request: Record<string, unknown>): Promise<any>;
  calendar(request: Record<string, unknown>): Promise<unknown>;
  family(request: Record<string, unknown>): Promise<unknown>;
  generateImage(request: Record<string, unknown>): Promise<{attachmentId:string} & Record<string, unknown>>;
  showImage(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  web(request: Record<string, unknown>): Promise<unknown>;
  research(request: { task: string; context?: string }): Promise<unknown>;
  readSkill(id: string, version: number): Promise<unknown>;
  readSkill(request: Record<string, unknown>): Promise<unknown>;
  skills(request: Record<string, unknown>): Promise<any>;
  runSkill(request: Record<string, unknown>): Promise<any>;
  createSchedule(definition: ScheduleDefinition): Promise<any>;
  complete(context: Static<typeof CompletionSchema>): Promise<AssistantMessage>;
  builds: {
    begin(specification: string): Promise<{ buildId: string; installed: unknown }>;
    update(buildId: string, status: 'repairing' | 'failed', diagnostic: string): Promise<void>;
    stage(buildId: string, module: ExtensionModule): Promise<{ hash: string; module: ExtensionModule; report: unknown; activated: boolean; tools: string[]; error?: string }>;
  };
}

export interface BackgroundContext { signal: AbortSignal; modelWorkAllowed: boolean; phase: number }
