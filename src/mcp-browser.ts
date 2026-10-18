import { isAbsolute, join, resolve } from 'node:path';
import { lstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { privateDirectory } from './config.js';
import { mcpSettings, type McpSettings } from './mcp-contracts.js';

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
    tools: ['browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_press_key', 'browser_select_option', 'browser_hover', 'browser_drag', 'browser_wait_for', 'browser_tabs', 'browser_close', 'browser_take_screenshot', 'browser_pdf_save'],
    readOnlyTools: [], resources: false, prompts: false, sampling: false, elicitation: false,
    timeoutMs: 90_000, maxBytes: 8_000_000
  }] });
}

export function prepareBrowserDirectories(root: string): void {
  const directory = privateDirectory(join(root, 'browser-mcp'));
  privateDirectory(join(directory, 'profile'));
  privateDirectory(join(directory, 'artifacts'));
}
