import { Type } from 'typebox';
import { object, validate } from './contracts.js';
import { Store, json } from './store.js';
import type { AgentTool } from '@earendil-works/pi-agent-core';

export const workflowSchema = object({ id: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }), description: Type.String({ maxLength: 1000 }), steps: Type.Array(object({ tool: Type.String(), args: Type.Record(Type.String(), Type.Unknown()) }), { minItems: 1, maxItems: 8 }) });
export interface Workflow { id: string; description: string; steps: { tool: string; args: Record<string, unknown> }[] }
const forbidden = new Set(['workflow_run', 'extension_build', 'skill_build', 'skills']);
export class Workflows {
  constructor(readonly store: Store) {}
  define(input: unknown, tools: AgentTool[]) {
    const definition = validate<Workflow>(workflowSchema, input);
    for (const step of definition.steps) {
      const tool = tools.find(tool => tool.name === step.tool);
      if (!tool || forbidden.has(step.tool)) throw new Error('Workflow step is not a permitted bounded tool');
      validate(tool.parameters, step.args);
    }
    return this.store.transaction(() => {
      const version = (this.store.get<{ version: number }>('SELECT MAX(version) version FROM workflow_versions WHERE id=?', definition.id)?.version ?? 0) + 1;
      this.store.run('INSERT INTO workflow_versions VALUES(?,?,?,?)', definition.id, version, json(definition), Date.now());
      this.store.run('INSERT OR REPLACE INTO workflows VALUES(?,?,1)', definition.id, json(definition)); return { id: definition.id, version };
    });
  }
  list() { return this.store.all<{ id: string; definition: string; enabled: number }>('SELECT * FROM workflows').map(row => ({ ...row, definition: JSON.parse(row.definition) })); }
  enable(id: string, enabled: boolean): void {
    if (!this.store.get('SELECT id FROM workflows WHERE id=?', id)) throw new Error('Workflow missing');
    this.store.run('UPDATE workflows SET enabled=? WHERE id=?', Number(enabled), id);
  }
  read(id: string): Workflow {
    const row = this.store.get<{ definition: string }>('SELECT definition FROM workflows WHERE id=? AND enabled=1', id);
    if (!row) throw new Error('Workflow disabled or missing');
    const definition = validate<Workflow>(workflowSchema, JSON.parse(row.definition));
    if (definition.steps.some(step => step.tool === 'extension_invoke')) throw new Error('Retired workflow dispatch: explicitly redefine steps with registered native tool names; saved history is unchanged');
    if (definition.steps.some(step => forbidden.has(step.tool))) throw new Error('Workflow tool revoked');
    return definition;
  }
  rollback(id: string, version: number, tools: AgentTool[]) {
    const row = this.store.get<{ definition: string }>('SELECT definition FROM workflow_versions WHERE id=? AND version=?', id, version);
    if (!row) throw new Error('Version missing');
    return this.define(JSON.parse(row.definition), tools);
  }
}
