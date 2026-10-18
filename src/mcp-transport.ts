import { AsyncLocalStorage } from 'node:async_hooks';
import { isJSONRPCRequest, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// The SDK probes subclasses in place instead of starting a disposable second server.
export class McpStdioTransport extends StdioClientTransport {}

export const legacyTaskCall = 'pico/internal/legacy-task-call';
export const mcpRequestSignal = new AsyncLocalStorage<AbortSignal>();

// SDK v2 treats tools/call results as ordinary tool results even on legacy connections.
// A private local alias keeps its normal cancellation/validation, while 2025 peers see tools/call.
export function mcpTransport(transport: Transport, parent: AbortSignal, activeSignal: () => AbortSignal | undefined): Transport {
  return new Proxy(transport, { get(target, key) {
    if (key === 'send') return ((message, options) => {
      const request = isJSONRPCRequest(message), signal = request && message.method !== 'subscriptions/listen' ? activeSignal() ?? parent : parent;
      return mcpRequestSignal.run(signal, async () => {
        signal.throwIfAborted();
        await target.send(request && message.method === legacyTaskCall ? { ...message, method: 'tools/call' } : message, options);
      });
    }) satisfies Transport['send'];
    const value: unknown = Reflect.get(target, key, target);
    if (key === 'constructor') return value;
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
