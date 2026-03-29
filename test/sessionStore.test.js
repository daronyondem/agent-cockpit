const fs = require('fs');
const path = require('path');
const os = require('os');
const session = require('express-session');
const FileStore = require('session-file-store')(session);

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createStore() {
  return new FileStore({
    path: tmpDir,
    ttl: 60,
    retries: 0,
  });
}

describe('file session store', () => {
  test('persists session to disk', (done) => {
    const store = createStore();
    const sessionData = { cookie: { maxAge: 60000 }, user: 'test@test.com', csrfToken: 'abc123' };

    store.set('test-session-1', sessionData, (err) => {
      expect(err).toBeFalsy();

      const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
      expect(files.length).toBeGreaterThanOrEqual(1);
      done();
    });
  });

  test('retrieves session from disk', (done) => {
    const store = createStore();
    const sessionData = { cookie: { maxAge: 60000 }, user: 'test@test.com', csrfToken: 'abc123' };

    store.set('test-session-2', sessionData, (err) => {
      expect(err).toBeFalsy();

      store.get('test-session-2', (err, data) => {
        expect(err).toBeFalsy();
        expect(data.user).toBe('test@test.com');
        expect(data.csrfToken).toBe('abc123');
        done();
      });
    });
  });

  test('survives store recreation (simulates restart)', (done) => {
    const store1 = createStore();
    const sessionData = { cookie: { maxAge: 60000 }, user: 'test@test.com' };

    store1.set('test-session-3', sessionData, (err) => {
      expect(err).toBeFalsy();

      // Create a new store pointing to the same directory (simulates server restart)
      const store2 = createStore();
      store2.get('test-session-3', (err, data) => {
        expect(err).toBeFalsy();
        expect(data.user).toBe('test@test.com');
        done();
      });
    });
  });

  test('destroy removes session from disk', (done) => {
    const store = createStore();
    const sessionData = { cookie: { maxAge: 60000 }, user: 'test@test.com' };

    store.set('test-session-4', sessionData, (err) => {
      expect(err).toBeFalsy();

      store.destroy('test-session-4', (err) => {
        expect(err).toBeFalsy();

        store.get('test-session-4', (err, data) => {
          expect(data).toBeFalsy();
          done();
        });
      });
    });
  });
});
