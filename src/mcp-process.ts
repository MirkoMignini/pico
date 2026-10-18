import { spawn } from 'node:child_process';

// The SDK owns this wrapper; the wrapper owns exactly one detached server process group.
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('MCP server command missing');
const child = spawn(command, args, { detached: true, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
let stopping = false;
const kill = (signal: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
const stop = () => { if (stopping) return; stopping = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 100).unref(); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
process.once('exit', () => kill('SIGKILL'));
process.stdin.pipe(child.stdin);
process.stdin.once('end', () => setTimeout(stop, 1000).unref());
child.stdin.on('error', () => {});
child.stdout.pipe(process.stdout, { end: false }); child.stderr.pipe(process.stderr, { end: false });
child.once('error', () => { process.stderr.write('MCP server process could not start\n'); process.exitCode = 1; process.stdin.destroy(); });
child.once('close', code => { kill('SIGKILL'); process.exitCode = code ?? 1; process.stdin.destroy(); });
