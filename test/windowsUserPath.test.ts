import { persistWindowsUserPathEntry } from '../src/services/windowsUserPath';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function mockProcessPlatform(platform: NodeJS.Platform): () => void {
  Object.defineProperty(process, 'platform', { value: platform });
  return () => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  };
}

describe('windowsUserPath', () => {
  test('emits PowerShell normalization without multi-character TrimEnd arguments', async () => {
    const restorePlatform = mockProcessPlatform('win32');
    const originalPath = process.env.PATH;
    const calls: Array<{ command: string; args: string[] }> = [];
    try {
      const result = await persistWindowsUserPathEntry(
        'C:\\Users\\daron\\AppData\\Local\\Agent Cockpit\\cli-tools',
        async (command, args) => {
          calls.push({ command, args });
          return { ok: true, stdout: 'ok', stderr: '' };
        },
      );

      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      const script = calls[0].args[calls[0].args.length - 1];
      expect(script).toContain("-replace '[\\\\/]+$'");
      expect(script).not.toContain("TrimEnd('\\\\', '/')");
    } finally {
      process.env.PATH = originalPath;
      restorePlatform();
    }
  });
});
