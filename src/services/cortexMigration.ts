import type { CliProfile } from '../types';
import { hasRequiredCliProfileConfig } from '../contracts/cliProfiles';
import { resolveCortexRuntime } from './backends/cortexRuntime';
import { CortexConnections, cortexSnowflakeHome } from './cortexConnections';

export const CORTEX_MIGRATION_WARNING = 'Cortex Code executables and Snowflake homes outside the data root are not included. Restore the CLI and selected connection on this machine, then run Check login in CLI Profiles to verify fresh inference access.';

/** Reserved native mkdtemp folders, including when TMPDIR is inside the data root. */
export function isCortexMigrationRuntimePath(relativePath: string): boolean {
  return relativePath.split('/').some(part => /^(?:agent-cockpit-cortex-plugin-|cockpit-cortex-(?:auth|login|restricted)-)[a-zA-Z0-9]{6}$/.test(part));
}

/** Passive destination checks: never execute an imported command or start login/inference. */
export async function checkCortexMigrationProfile(profile: CliProfile, dataRoot: string): Promise<{ status: 'warning'; message: string }> {
  const label = `${profile.name || profile.id} (cortex-code)`;
  const warning = (message: string) => ({ status: 'warning' as const,
    message: `${label}: ${message} Authentication has not been checked; run Check login in CLI Profiles on this machine.` });
  if (!hasRequiredCliProfileConfig(profile)) return warning('Select a Snowflake connection in this profile.');
  let runtime: ReturnType<typeof resolveCortexRuntime>;
  try { runtime = resolveCortexRuntime({ profile, cwd: dataRoot, workspaceId: 'migration-check' }); }
  catch { return warning('Cortex Code executable/runtime is unavailable; install the CLI or update the profile command.'); }
  try {
    await new CortexConnections(cortexSnowflakeHome(runtime.env)).selected(profile.cortexCode!.connection);
  } catch {
    return warning('The selected Snowflake connection is unavailable or connections.toml cannot be safely read; restore or select a connection in the profile\'s native Snowflake home.');
  }
  return warning('The executable file and selected Snowflake connection are present. Native session history and credential validity are machine-dependent.');
}
