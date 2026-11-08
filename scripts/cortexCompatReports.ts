import fs from 'fs/promises';
import path from 'path';

export const CORTEX_PROBES = {
  backend: [
    { id: 'runtime', flag: 'CORTEX_RUNTIME_PROBE', prefix: 'cockpit-cortex-runtime-', minutes: 8 },
    { id: 'events', flag: 'CORTEX_EVENTS_PROBE', prefix: 'cockpit-cortex-events-', minutes: 15 },
    { id: 'processors', flag: 'CORTEX_PROCESSOR_PROBE', prefix: 'cockpit-cortex-processors-', minutes: 12 },
  ],
  ui: [
    { id: 'auth', flag: 'CORTEX_AUTH_PROBE', prefix: 'cockpit-cortex-auth-ui-', minutes: 12 },
    { id: 'interactions', flag: 'CORTEX_INTERACTION_PROBE', prefix: 'cockpit-cortex-interactions-', minutes: 12 },
    { id: 'queue', flag: 'CORTEX_QUEUE_PROBE', prefix: 'cockpit-cortex-queue-', minutes: 10 },
    { id: 'usage', flag: 'CORTEX_USAGE_PROBE', prefix: 'cockpit-cortex-usage-', minutes: 12 },
    { id: 'mobile', flag: 'CORTEX_MOBILE_PROBE', prefix: 'cockpit-cortex-mobile-', minutes: 15 },
  ],
} as const;
export type CortexCompatSuite = keyof typeof CORTEX_PROBES;

export function selectCortexProbes(suite: CortexCompatSuite, args: string[]) {
  const ids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--probe' || !args[i + 1]) throw new Error('Use --probe <id> or --list');
    ids.push(args[++i]);
  }
  const available = CORTEX_PROBES[suite];
  if (ids.some(id => !available.some(probe => probe.id === id)) || new Set(ids).size !== ids.length) throw new Error('Unknown or duplicate probe selection');
  return available.filter(probe => !ids.length || ids.includes(probe.id));
}

/** Project only validated metadata and fixed outcomes, never native report text/keys. */
export async function readCortexProbeReport(tmp: string, prefix: string, revision: string) {
  const dirs = (await fs.readdir(tmp, { withFileTypes: true })).filter(item => item.isDirectory() && item.name.startsWith(prefix));
  if (dirs.length !== 1) throw new Error('Expected one native probe report');
  const file = path.join(tmp, dirs[0].name, 'report.json');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid native report file');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  const cliVersion = raw.cliVersion || raw.results?.cliVersion;
  if (raw.platform !== process.platform || raw.arch !== process.arch || raw.node !== process.version
    || cliVersion !== '1.2.35' || raw.revision !== revision || typeof raw.dirty !== 'boolean') throw new Error('Native report metadata mismatch');
  return { passed: raw.results?.passed === true && raw.results?.deadlineExceeded !== true,
    cliVersion: '1.2.35', revision, dirty: raw.dirty as boolean };
}
