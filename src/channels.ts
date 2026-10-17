import { ChannelSchema, DestinationSchema, validate, type Envelope, type OutputEvent, type PicoChannel } from './contracts.js';
import type { Runtime } from './runtime.js';

export class Channels {
  private adapters = new Map<string, { channel: PicoChannel; output: (event: OutputEvent) => void }>();
  private started = false;
  private closing?: Promise<void>;
  constructor(readonly runtime: Runtime) {}
  get inputEpoch(): number { return this.runtime.inputEpoch; }

  register<T extends PicoChannel>(channel: T): T {
    if (this.started) throw new Error('Register channels before starting the runtime; use attach for approved modules');
    return this.install(channel);
  }

  async attach(channel: PicoChannel): Promise<void> {
    this.install(channel);
    try { if (this.started) await channel.start(); }
    catch (error) { await this.detach(channel.id); throw error; }
  }

  async detach(id: string): Promise<void> {
    const entry = this.adapters.get(id); if (!entry) return;
    this.adapters.delete(id); this.runtime.events.off('output', entry.output);
    for (const destination of entry.channel.deliveries?.keys() ?? []) this.runtime.scheduler.deliveries.delete(destination);
    await entry.channel.close();
  }

  private install<T extends PicoChannel>(channel: T): T {
    validate(ChannelSchema, channel.id);
    if (['schedule', 'review', 'global'].includes(channel.id)) throw new Error('Reserved channel ID');
    if (this.closing) throw new Error('Channels are closing');
    if (this.adapters.has(channel.id)) throw new Error(`Channel already registered: ${channel.id}`);
    for (const destination of channel.deliveries?.keys() ?? []) {
      validate(DestinationSchema, destination);
      if (destination !== channel.id && !destination.startsWith(`${channel.id}:`)) throw new Error('Delivery destination must belong to its channel');
      if (this.runtime.scheduler.deliveries.has(destination)) throw new Error(`Delivery already registered: ${destination}`);
    }
    const output = (event: OutputEvent) => {
      if (event.channel && event.channel !== channel.id) return;
      const failed = () => { if (event.type !== 'diagnostic') this.runtime.emit({ type: 'diagnostic', data: { component: channel.id, error: 'Channel output handling failed' } }); };
      try { const result = channel.onOutput?.(event); if (result) void result.catch(failed); } catch { failed(); }
    };
    this.adapters.set(channel.id, { channel, output });
    for (const [destination, delivery] of channel.deliveries ?? []) this.runtime.scheduler.deliveries.set(destination, delivery);
    this.runtime.events.on('output', output);
    return channel;
  }

  list(): { id: string; destinations: string[] }[] {
    return [...this.adapters.values()].map(({ channel }) => ({ id: channel.id, destinations: [...(channel.deliveries?.keys() ?? [])] }));
  }

  async ingest(channel: string, input: unknown, sender: Omit<Envelope['source'], 'channel'>, mode: 'foreground' | 'ephemeral' = 'foreground', epoch = this.runtime.inputEpoch) {
    if (this.closing || !this.adapters.has(channel)) throw new Error('Channel is not registered or is closing');
    return this.runtime.ingest(input, { ...sender, channel }, mode, epoch);
  }

  async start(): Promise<void> {
    if (this.closing) throw new Error('Channels are closing');
    if (this.started) return;
    this.started = true;
    try { for (const { channel } of this.adapters.values()) await channel.start(); }
    catch (error) { await this.close(); throw error; }
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      const adapters = [...this.adapters.values()].reverse();
      this.adapters.clear();
      for (const { channel, output } of adapters) {
        this.runtime.events.off('output', output);
        for (const destination of channel.deliveries?.keys() ?? []) this.runtime.scheduler.deliveries.delete(destination);
      }
      const results = await Promise.allSettled(adapters.map(({ channel }) => Promise.resolve().then(() => channel.close())));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Channel shutdown failed');
    })();
  }
}
