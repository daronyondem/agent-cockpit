import path from 'path';

describe('config data root', () => {
  const originalEnv = { ...process.env };

  function loadConfig() {
    // Reload after env changes; dynamic import requires explicit extensions
    // under NodeNext, while Jest's CJS require handles this test case cleanly.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../src/config').default;
  }

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  test('defaults mutable data under the process data directory', async () => {
    process.env.AGENT_COCKPIT_DATA_DIR = '';
    process.env.AUTH_DATA_DIR = '';
    jest.resetModules();

    const config = loadConfig();

    expect(config.AGENT_COCKPIT_DATA_DIR).toBe(path.join(process.cwd(), 'data'));
    expect(config.AUTH_DATA_DIR).toBe(path.join(process.cwd(), 'data', 'auth'));
  });

  test('derives auth storage from AGENT_COCKPIT_DATA_DIR unless AUTH_DATA_DIR is explicit', async () => {
    const dataRoot = path.join(process.cwd(), 'tmp-data-root');
    process.env.AGENT_COCKPIT_DATA_DIR = dataRoot;
    process.env.AUTH_DATA_DIR = '';
    jest.resetModules();

    let config = loadConfig();
    expect(config.AGENT_COCKPIT_DATA_DIR).toBe(dataRoot);
    expect(config.AUTH_DATA_DIR).toBe(path.join(dataRoot, 'auth'));

    const authDir = path.join(process.cwd(), 'custom-auth-root');
    process.env.AUTH_DATA_DIR = authDir;
    jest.resetModules();

    config = loadConfig();
    expect(config.AGENT_COCKPIT_DATA_DIR).toBe(dataRoot);
    expect(config.AUTH_DATA_DIR).toBe(authDir);
  });
});
