import fs from 'fs';
import { detectLibreOffice, resetLibreOfficeDetection } from '../src/services/knowledgeBase/libreOffice';

const mockExecFileFn = jest.fn();
jest.mock('child_process', () => ({
  execFile: function () { return mockExecFileFn.apply(null, arguments); },
}));

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const originalHome = process.env.HOME;
const originalExistsSync = fs.existsSync;

function mockProcessPlatform(platform: NodeJS.Platform): () => void {
  Object.defineProperty(process, 'platform', { value: platform });
  return () => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  };
}

function mockMissingPathCommand() {
  mockExecFileFn.mockImplementation((...args: unknown[]) => {
    const callback = args.find((arg): arg is (err: Error) => void => typeof arg === 'function');
    callback?.(new Error('not found'));
  });
}

describe('LibreOffice detection', () => {
  afterEach(() => {
    process.env.HOME = originalHome;
    mockExecFileFn.mockReset();
    jest.restoreAllMocks();
  });

  test('detects a standard macOS LibreOffice.app install when soffice is not on PATH', async () => {
    const restorePlatform = mockProcessPlatform('darwin');
    const appSoffice = '/Applications/LibreOffice.app/Contents/MacOS/soffice';
    process.env.HOME = '/Users/tester';
    mockMissingPathCommand();
    jest.spyOn(fs, 'existsSync').mockImplementation((candidate: fs.PathLike) => (
      String(candidate) === appSoffice ? true : originalExistsSync(candidate)
    ));
    resetLibreOfficeDetection();

    try {
      const status = await detectLibreOffice({ refresh: true });

      expect(status).toEqual(expect.objectContaining({
        available: true,
        binaryPath: appSoffice,
      }));
    } finally {
      restorePlatform();
      resetLibreOfficeDetection();
    }
  });
});
