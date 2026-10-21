import { expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { initialize } from '../src/config.js';

const read = (name: string) => readFileSync(new URL(`../deploy/${name}`, import.meta.url), 'utf8');

it('keeps the single-owner Compose stack non-root, bounded and off host ports and Docker sockets', () => {
  const config = parse(read('compose.yaml'));
  expect(config.name).toBe('pikobot');
  expect(Object.keys(config.services)).toEqual(['pikobot']);
  const service = config.services.pikobot;
  expect(service.image).toContain('${PIKOBOT_IMAGE:?');
  expect(service.build).toEqual({ context: '..', dockerfile: 'deploy/Dockerfile' });
  expect(service.user).toBe('1000:1000');
  expect(service.init).toBe(true);
  expect(service.restart).toBe('unless-stopped');
  expect(service.read_only).toBe(true);
  expect(service.cap_drop).toEqual(['ALL']);
  expect(service.security_opt).toEqual(['no-new-privileges:true']);
  expect(service.privileged).toBeUndefined();
  expect(service.network_mode).toBeUndefined();
  expect(service.ports).toBeUndefined();
  expect(service.cpus).toBe(2);
  expect(service.mem_limit).toBe('6g');
  expect(service.memswap_limit).toBe(service.mem_limit);
  expect(service.pids_limit).toBe(256);
  expect(service.volumes).toEqual([{ type: 'bind', source: '/srv/appdata/pikobot', target: '/data', bind: { create_host_path: false } }]);
  expect(service.environment).toEqual({ HOME: '/data' });
  expect(service.tmpfs).toEqual(['/tmp:rw,nosuid,nodev,size=256m,mode=1777']);
  expect(service.healthcheck.test).toEqual(['CMD', 'node', '/app/dist/cli.js', '--instance', '/data', 'readiness']);
  expect(service.logging).toEqual({ driver: 'local', options: { 'max-size': '10m', 'max-file': '3' } });
});

it('schedules application backups against the existing stack without logging manifests or copying live SQLite', () => {
  const service = read('pikobot-backup.service'), timer = read('pikobot-backup.timer');
  expect(service).toContain('WorkingDirectory=/srv/stacks/pikobot\n');
  expect(service).toContain('ExecStart=/usr/bin/docker compose --env-file /srv/stacks/pikobot/deployment.env -f /srv/stacks/pikobot/deploy/compose.yaml exec -T pikobot node --input-type=module -e "import { Client } from \'/app/dist/client.js\'; await new Client(\'/data\').rpc(\'backup\');"\n');
  expect(service).toContain('StandardOutput=null\n');
  expect(service).toContain('UMask=0077\n');
  expect(service).not.toMatch(/Restart=|docker compose.*\b(up|run)\b|\bcp\b|\.sqlite/);
  expect(timer).toContain('OnCalendar=*-*-* 04:15:00\n');
  expect(timer).toContain('RandomizedDelaySec=15m\n');
  expect(timer).toContain('Persistent=true\n');
  expect(timer).toContain('WantedBy=timers.target\n');
});

it('fails the backup command without creating a replacement daemon when IPC is absent', () => {
  const code = read('pikobot-backup.service').match(/ --input-type=module -e "([^"\n]+)"\n/)?.[1];
  expect(code).toBe("import { Client } from '/app/dist/client.js'; await new Client('/data').rpc('backup');");
  const root = mkdtempSync('/tmp/pikobot-backup-service-');
  try {
    initialize(root, 'Synthetic backup service');
    const localCode = code!.replace("'/app/dist/client.js'", JSON.stringify(fileURLToPath(new URL('../dist/client.js', import.meta.url)))).replace("'/data'", JSON.stringify(root));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', localCode], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ENOENT');
    expect(existsSync(join(root, 'daemon.sock'))).toBe(false);
    expect(existsSync(join(root, 'pikobot.sqlite'))).toBe(false);
    expect(readdirSync(join(root, 'backups'))).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15_000);
