declare module 'session-file-store' {
  import session from 'express-session';

  interface FileStoreOptions {
    path?: string;
    ttl?: number;
    retries?: number;
    factor?: number;
    minTimeout?: number;
    maxTimeout?: number;
    reapInterval?: number;
    reapMaxAge?: number;
    reapAsync?: boolean;
    reapSyncFallback?: boolean;
    logFn?: (...args: unknown[]) => void;
    fallbackSessionFn?: () => Record<string, unknown>;
    secret?: string;
    encoder?: (data: string) => string;
    decoder?: (data: string) => string;
    encryptEncoding?: string;
    fileExtension?: string;
    keyFunction?: (secret: string, sessionId: string) => string;
  }

  function FileStoreFactory(
    session: typeof import('express-session'),
  ): new (options?: FileStoreOptions) => session.Store;

  export = FileStoreFactory;
}
