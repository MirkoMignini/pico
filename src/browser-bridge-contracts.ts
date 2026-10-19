import { Type, type Static } from 'typebox';
import { object } from './contracts.js';

export const BRIDGE_FILE_BYTES = 10_000_000;
export const BRIDGE_RESULT_BYTES = 20_000_000;
export const BridgeIdSchema = Type.String({ pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' });
export const BridgeConfigSchema = object({ version: Type.Literal(1), id: BridgeIdSchema, entrypoint: Type.String({ minLength: 1, maxLength: 4000 }), profile: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$' }), port: Type.Integer({ minimum: 1, maximum: 65535 }) });
export type BridgeConfig = Static<typeof BridgeConfigSchema>;
export const BridgePairingSchema = object({ version: Type.Literal(1), bridgeId: BridgeIdSchema, url: Type.String({ minLength: 1, maxLength: 4000 }), token: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }) });
export type BridgePairing = Static<typeof BridgePairingSchema>;
export const BridgeArtifactSchema = object({ name: Type.String({ minLength: 1, maxLength: 120 }), uri: Type.String({ pattern: '^pikobot-browser-artifact:[a-f0-9-]{36}:[a-f0-9]{64}$' }), mimeType: Type.String({ minLength: 1, maxLength: 100 }), bytes: Type.Integer({ minimum: 0, maximum: BRIDGE_FILE_BYTES }), hash: Type.String({ pattern: '^[a-f0-9]{64}$' }) });
export type BridgeArtifact = Static<typeof BridgeArtifactSchema>;
