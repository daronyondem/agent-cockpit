/** Reviewed Snowflake standalone distribution; native Windows acceptance is separate. */
export const CORTEX_INSTALL_DOCS = 'https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli';

export function cortexInstallCommand(): string[] | null {
  const supported = process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)
    || process.platform === 'linux' && process.arch === 'x64';
  if (!supported) return null;
  // Download must succeed before execution. Skip terminal/profile prompts, and
  // use the normal user home independently of any profile's SNOWFLAKE_HOME.
  return ['sh', '-c', [
    'set -eu',
    'cortex_installer=$(mktemp)',
    'trap \'rm -f "$cortex_installer"\' EXIT',
    'curl -qfsSL --connect-timeout 30 --max-time 120 https://ai.snowflake.com/static/cc-scripts/install.sh -o "$cortex_installer"',
    'CORTEX_CHANNEL=stable NON_INTERACTIVE=1 SKIP_PATH_PROMPT=1 sh "$cortex_installer"',
  ].join('\n')];
}
