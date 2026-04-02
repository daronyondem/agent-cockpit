import fs from 'fs';
import path from 'path';
import os from 'os';
import session from 'express-session';
import FileStoreFactory from 'session-file-store';

const FileStore = FileStoreFactory(session);

let tmpDir: string;

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

    store.set('test-session-1', sessionData as any, (err: any) => {
      expect(err).toBeFalsy();

      const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
      expect(files.length).toBeGreaterThanOrEqual(1);
      done();
    });
  });

  test('retrieves session from disk', (done) => {
    const store = createStore();
    const sessionData = { cookie: { maxAge: 60000 }, user: 'test@test.com', csrfToken: 'abc123' };

    store.set('test-session-2', sessionData as any, (err: any) => {
      expect(err).toBeFalsy();

      store.get('test-session-2', (err: any, data: any) => {
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

    store1.set('test-session-3', sessionData as any, (err: any) => {
      expect(err).toBeFalsy();

      const store2 = createStore();
      store2.get('test-session-3', (err: any, data: any) => {
        expect(err).toBeFalsy();
        expect(data.user).toBe('test@test.com');
        done();
      });
    });
  });

  test('destroy removes session from disk', (done) => {
    const store = createStore();
    const sessionData = { cookie: { maxAge: 60000 }, user: 'test@test.com' };

    store.set('test-session-4', sessionData as any, (err: any) => {
      expect(err).toBeFalsy();

      store.destroy('test-session-4', (err: any) => {
        expect(err).toBeFalsy();

        store.get('test-session-4', (err: any, data: any) => {
          expect(data).toBeFalsy();
          done();
        });
      });
    });
  });
});
