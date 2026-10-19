import { isAbsolute, join, resolve } from 'node:path';
import { lstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { privateDirectory } from './config.js';
import { validate } from './contracts.js';
import { BridgePairingSchema, BRIDGE_RESULT_BYTES, type BridgePairing } from './browser-bridge-contracts.js';
import { mcpSettings, mcpUrl, type McpSettings } from './mcp-contracts.js';

export const BROWSER_TOOLS = ['browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_press_key', 'browser_select_option', 'browser_hover', 'browser_drag', 'browser_wait_for', 'browser_tabs', 'browser_close', 'browser_take_screenshot', 'browser_pdf_save'];

export function browserArtifactMentioned(text: string, file: string): boolean {
  if (!file || file.length > 120 || /^[.]|[/\\\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(file)) return false;
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}._-])${escaped}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}._-])`, 'u').test(text);
}

export function bridgeUrl(raw: string): string {
  const url = mcpUrl(raw);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.pathname !== '/mcp' || url.search) throw new Error('Use the exact loopback /mcp endpoint of a private SSH tunnel, not a public browser endpoint');
  return url.href;
}

export function remoteBrowserSettings(settings: unknown, raw: unknown): { settings: McpSettings; pairing: BridgePairing } {
  const current = mcpSettings(settings); let pairing: BridgePairing;
  try { pairing = validate<BridgePairing>(BridgePairingSchema, raw); } catch { throw new Error('Invalid browser bridge pairing; expected only version, bridgeId, url and token'); }
  if (current.servers.some(server => server.id === 'browser-remote')) throw new Error('browser-remote already exists; inspect /mcp setup rather than replacing its identity or credentials');
  return { pairing, settings: mcpSettings({ servers: [...current.servers, {
    id: 'browser-remote', enabled: true, transport: 'http', url: bridgeUrl(pairing.url), browserBridgeId: pairing.bridgeId,
    allowPrivateNetwork: true, tools: BROWSER_TOOLS, autonomousTools: BROWSER_TOOLS, readOnlyTools: [],
    resources: true, prompts: false, sampling: false, elicitation: false, timeoutMs: 90_000, maxBytes: BRIDGE_RESULT_BYTES
  }] }) };
}

export function browserSettings(root: string, settings: unknown, entrypoint: string): McpSettings {
  const current = mcpSettings(settings);
  if (current.servers.some(server => server.id === 'browser')) throw new Error('MCP server browser already exists; inspect /mcp setup rather than overwriting its profile or permissions');
  if (!isAbsolute(entrypoint) || /[\x00-\x1f\x7f]/.test(entrypoint) || !lstatSync(entrypoint).isFile()) throw new Error('Select the absolute path to an already installed, trusted Playwright MCP cli.js');
  const directory = join(resolve(root), 'browser-mcp'), artifacts = join(directory, 'artifacts');
  return mcpSettings({ servers: [...current.servers, {
    id: 'browser', enabled: true, transport: 'stdio', command: process.execPath,
    args: [entrypoint, '--browser', 'chrome', '--user-data-dir', join(directory, 'profile'), '--output-dir', artifacts, '--file-paths', 'absolute', '--caps', 'pdf', '--no-webmcp', '--block-service-workers', '--codegen', 'none'],
    cwd: artifacts, artifactDirectory: artifacts,
    roots: [{ uri: pathToFileURL(artifacts).href, name: 'Dedicated browser output' }],
    tools: BROWSER_TOOLS, autonomousTools: BROWSER_TOOLS, readOnlyTools: [], resources: false, prompts: false, sampling: false, elicitation: false,
    timeoutMs: 90_000, maxBytes: 8_000_000
  }] });
}

export function prepareBrowserDirectories(root: string): void {
  const directory = privateDirectory(join(root, 'browser-mcp'));
  privateDirectory(join(directory, 'profile'));
  privateDirectory(join(directory, 'artifacts'));
}
