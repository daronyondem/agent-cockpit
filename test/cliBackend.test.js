const { CLIBackend } = require('../src/services/cliBackend');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('CLIBackend', () => {
  describe('constructor', () => {
    test('uses default working directory', () => {
      const backend = new CLIBackend();
      expect(backend.workingDir).toContain('.openclaw');
    });

    test('accepts custom working directory', () => {
      const backend = new CLIBackend({ workingDir: '/tmp/test' });
      expect(backend.workingDir).toBe('/tmp/test');
    });
  });

  describe('sendMessage', () => {
    test('returns stream and abort function', async () => {
      const backend = new CLIBackend({ workingDir: '/tmp' });
      const { stream, abort } = backend.sendMessage('hello', {
        sessionId: 'test-session',
        isNewSession: true,
        workingDir: '/tmp',
      });

      expect(stream).toBeDefined();
      expect(typeof stream[Symbol.asyncIterator]).toBe('function');
      expect(typeof abort).toBe('function');

      abort();
      for await (const event of stream) {
        if (event.type === 'done') break;
      }
      // Wait for OS-level process close callbacks to settle
      await sleep(500);
    }, 10000);

    test('abort yields error and done events', async () => {
      const backend = new CLIBackend({ workingDir: '/tmp' });
      const { stream, abort } = backend.sendMessage('hello', {
        sessionId: 'test-abort',
        isNewSession: true,
        workingDir: '/tmp',
      });

      abort();

      const events = [];
      for await (const event of stream) {
        events.push(event);
        if (event.type === 'done') break;
      }

      expect(events.some(e => e.type === 'error')).toBe(true);
      expect(events[events.length - 1].type).toBe('done');
      await sleep(500);
    }, 10000);
  });
});
