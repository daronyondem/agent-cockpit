import { runCortexCompatibility } from './run-cortex-code-compat';

void runCortexCompatibility('auth-control').catch(() => {
  process.stderr.write('CoCo auth control setup failed. Use --help; native runs require CORTEX_CODE_E2E=1 and macOS.\n'); process.exitCode = 1;
});
