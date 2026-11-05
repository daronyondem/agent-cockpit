import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { nodeRuntimeMeetsRequirement } from '../src/services/nodeRuntimeRequirement';

test.each([
  ['22.11.9', false], ['22.12.0', true], ['22.12.1', true], ['22.23.4', true],
  ['23.0.0', true], ['20.19.0', false], ['v22.12.0', true],
  ['22.12.0-rc.1', false], ['unknown', false], [null, false],
])('Node %s is eligible for the SDK runtime: %s', (version, expected) => {
  expect(nodeRuntimeMeetsRequirement(version)).toBe(expected);
});

test('honors a target release engine, including patch floors and legacy major-only manifests', () => {
  expect(nodeRuntimeMeetsRequirement('22.12.1', 22, '>=22.12.2')).toBe(false);
  expect(nodeRuntimeMeetsRequirement('22.13.0', 22, '>=22.12.2')).toBe(true);
  expect(nodeRuntimeMeetsRequirement('22.0.0', 22, '>=22')).toBe(true);
  expect(nodeRuntimeMeetsRequirement('21.9.0', 22, null)).toBe(false);
  expect(nodeRuntimeMeetsRequirement('22.0.0', 22, null)).toBe(true);
  expect(nodeRuntimeMeetsRequirement('22.99.0', 23, '>=22.12.0')).toBe(false);
});

const posix = process.platform === 'win32' ? describe.skip : describe;
posix('production POSIX installer Node eligibility', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node minimum '));
    fs.writeFileSync(path.join(dir, 'node'), `#!/bin/sh
case "$2" in
  "process.versions.node.split('.')[0]") echo "\${FIXTURE_NODE_VERSION%%.*}" ;;
  "process.versions.node.split('.')[1]") tail="\${FIXTURE_NODE_VERSION#*.}"; echo "\${tail%%.*}" ;;
  "process.versions.node") echo "$FIXTURE_NODE_VERSION" ;;
  *) echo "v$FIXTURE_NODE_VERSION" ;;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'npm'), '#!/bin/sh\necho 10.9.0\n', { mode: 0o755 });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test.each([
    ['macos', '22.11.9', 'private'], ['macos', '22.12.0', 'system'], ['macos', '23.0.0', 'system'],
    ['linux', '22.11.9', 'private'], ['linux', '22.12.0', 'system'], ['linux', '23.0.0', 'system'],
  ])('%s installer uses %s through the %s path', (platform, version, expected) => {
    const source = fs.readFileSync(path.join(process.cwd(), `scripts/install-${platform}.sh`), 'utf8');
    const ensureNode = source.match(/ensure_node\(\) \{[\s\S]*?\n\}/)![0];
    const output = execFileSync('bash', ['-c', `set -euo pipefail
INSTALL_NODE=true
log() { :; }
fail() { echo "$*" >&2; exit 1; }
install_private_node() { NODE_RUNTIME_SOURCE=private; }
${ensureNode}
ensure_node
echo "$NODE_RUNTIME_SOURCE"
`], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:/usr/bin:/bin`, FIXTURE_NODE_VERSION: version } });
    expect(output.trim()).toBe(expected);
  });
});
