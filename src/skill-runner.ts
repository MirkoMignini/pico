import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { privateDirectory } from './config.js';
import { readRegular, skillPath, type PackageFile } from './skill-package.js';

export interface SkillRunInput { path: string; bytes: Buffer }
export interface SkillRunRequest { script: string; args?: string[]; stdin?: string; timeoutMs?: number; outputs?: string[] }
export interface SkillRunResult { status: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'output_limit'; exitCode: number | null; signal: string | null; stdout: string; stderr: string; outputTruncated: boolean; durationMs: number; files: SkillRunInput[] }
const OUTPUT_LIMIT = 1_000_000;
const interpreters: Record<string, string> = { '.py': 'python3', '.sh': '/bin/bash', '.bash': '/bin/bash', '.rb': 'ruby', '.pl': 'perl' };

export async function runSkill(root: string, files: PackageFile[], request: SkillRunRequest, inputs: SkillRunInput[], signal: AbortSignal): Promise<SkillRunResult> {
  signal.throwIfAborted();
  const script = skillPath(request.script);
  if (!files.some(file => file.path === script)) throw new Error('Script is not a file in this installed skill');
  const extension = extname(script).toLowerCase(), node = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'].includes(extension);
  const interpreter = node ? process.execPath : interpreters[extension];
  if (!interpreter) throw new Error('Unsupported script language. Use Node.js/TypeScript, Python, Bash, Ruby or Perl; dependencies/interpreters must already be installed');
  const directory = mkdtempSync(join(privateDirectory(join(root, 'skill-work')), 'run-'));
  try {
    const all = [...files.map(file => ({ path: file.path, bytes: file.bytes })), ...inputs.map(input => ({ path: `inputs/${skillPath(input.path)}`, bytes: input.bytes }))];
    const names = new Set<string>();
    for (const file of all) {
      const path = skillPath(file.path), key = path.normalize('NFKC').toLowerCase();
      if (names.has(key)) throw new Error('Skill input collides with a packaged file');
      names.add(key);
      mkdirSync(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, path), file.bytes, { mode: 0o600, flag: 'wx' });
    }
    const home = join(directory, '.home'); mkdirSync(home, { mode: 0o700 });
    mkdirSync(join(directory, 'outputs'), { recursive: true, mode: 0o700 });
    const started = performance.now(), timeoutMs = request.timeoutMs ?? 30_000;
    const commandArgs = [...(node ? ['--max-old-space-size=128'] : extension === '.py' ? ['-B', '-s'] : []), join(directory, script), ...(request.args ?? [])];
    const child = spawn(interpreter, commandArgs, { cwd: directory, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', LANG: 'C.UTF-8', PICO_SKILL_ROOT: directory, PICO_SKILL_INPUTS: join(directory, 'inputs'), PICO_SKILL_OUTPUTS: join(directory, 'outputs') } });
    let status: SkillRunResult['status'] = 'completed', bytes = 0, outputTruncated = false, killTimer: NodeJS.Timeout | undefined, drainTimer: NodeJS.Timeout | undefined;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const kill = (kind: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.platform === 'win32' ? child.kill(kind) : process.kill(-child.pid, kind); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(kind); }
    };
    const stop = (reason: SkillRunResult['status']) => {
      if (status !== 'completed') return;
      status = reason; kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 300);
    };
    const collect = (target: Buffer[]) => (data: Buffer) => {
      const room = Math.max(0, OUTPUT_LIMIT - bytes); bytes += data.length;
      if (room) target.push(data.subarray(0, room));
      if (bytes > OUTPUT_LIMIT) { outputTruncated = true; stop('output_limit'); }
    };
    child.once('exit', () => {
      kill('SIGKILL');
      // Escaped descendants must not hold inherited pipes open past the invocation.
      drainTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 300);
    });
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.stdin.on('error', () => {});
    child.stdin.end(request.stdin ?? '');
    const abort = () => stop('cancelled');
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => stop('timed_out'), timeoutMs);
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      if (signal.aborted) abort();
      exit = await new Promise((resolve, reject) => { child.once('error', error => reject(new Error(`Could not start skill interpreter (${interpreter}): ${(error as NodeJS.ErrnoException).code ?? 'failed'}. Install its documented prerequisites explicitly; Pico does not install dependencies.`, { cause: error }))); child.once('close', (code, signal) => resolve({ code, signal })); });
      if (status === 'completed' && exit.code !== 0) status = 'failed';
    } finally {
      clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); if (drainTimer) clearTimeout(drainTimer);
      signal.removeEventListener('abort', abort);
      // Only this invocation's process group; cleanup cannot undo earlier external effects.
      kill('SIGKILL');
    }
    const outputs: SkillRunInput[] = [];
    if (status === 'completed' && !signal.aborted) for (const name of request.outputs ?? []) {
      const path = skillPath(name);
      let current = directory;
      for (const part of path.split('/')) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error('Skill outputs cannot contain symlinks'); }
      const bytes = readRegular(join(directory, path));
      if (outputs.reduce((size, file) => size + file.bytes.length, bytes.length) > OUTPUT_LIMIT * 10) throw new Error('Skill output files exceed total limit');
      outputs.push({ path, bytes });
    }
    return { status, exitCode: exit.code, signal: exit.signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), outputTruncated, durationMs: Math.round(performance.now() - started), files: outputs };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
