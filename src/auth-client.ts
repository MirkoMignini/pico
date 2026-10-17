import { setTimeout as sleep } from 'node:timers/promises';
import type { AuthEvent, AuthInteraction, AuthType } from '@earendil-works/pi-ai';
import type { Client } from './client.js';
import type { LoginStatus } from './oauth.js';

export function authEventText(event: AuthEvent): string {
  if (event.type === 'auth_url') return `${event.instructions ?? 'Open in your browser:'}\n${event.url}`;
  if (event.type === 'device_code') return `Open ${event.verificationUri}\nDevice code: ${event.userCode}\nWaiting for authentication…`;
  return event.message + (event.type === 'info' ? (event.links ?? []).map(link => `\n${link.label ?? 'More information'}: ${link.url}`).join('') : '');
}

/** Keep polling while a prompt is open: browser callbacks can complete it without terminal input. */
export async function loginProvider(client: Client, provider: string, type: AuthType, interaction: AuthInteraction, account = 'default'): Promise<LoginStatus> {
  let status = await client.rpc<LoginStatus>('auth.start', { provider, type, account });
  let sequence = 0, failure: unknown;
  let prompt: { id: string; controller: AbortController } | undefined;
  try {
    while (status.state === 'pending') {
      interaction.signal?.throwIfAborted();
      if (failure) throw failure;
      for (const item of status.events) if (item.seq > sequence) { interaction.notify(item.event); sequence = item.seq; }
      if (prompt?.id !== status.prompt?.id) { prompt?.controller.abort(); prompt = undefined; }
      if (status.prompt && !prompt) {
        const controller = new AbortController(), value = status.prompt;
        prompt = { id: value.id, controller };
        const signal = interaction.signal ? AbortSignal.any([controller.signal, interaction.signal]) : controller.signal;
        void Promise.resolve().then(() => interaction.prompt({ ...value, signal })).then(async answer => {
          if (!signal.aborted) await client.rpc('auth.respond', { id: status.id, promptId: value.id, value: answer });
        }).catch(error => { if (!signal.aborted) failure = error; });
      }
      await sleep(100, undefined, { signal: interaction.signal });
      status = await client.rpc<LoginStatus>('auth.status', { id: status.id });
    }
    if (status.state === 'failed' || status.state === 'expired') throw new Error(status.error ?? 'Provider login expired');
    return status;
  } finally {
    prompt?.controller.abort();
    if (status.state === 'pending') await client.rpc('auth.cancel', { id: status.id }).catch(() => {});
  }
}
