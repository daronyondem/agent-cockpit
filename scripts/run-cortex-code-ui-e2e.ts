import { runCortexCompatibility } from './run-cortex-code-compat';

void runCortexCompatibility('ui').catch(() => {
  process.stderr.write('CoCo UI setup failed. Use --help; native runs require CORTEX_CODE_E2E=1 and macOS.\n'); process.exitCode = 1;
});
