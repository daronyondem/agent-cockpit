/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Knowledge Base embedding service tests ─────────────────────────────────
// Tests the pure helper functions and mocks the Ollama HTTP API for
// embedText / embedBatch / checkOllamaHealth.

import {
  EMBEDDING_DEFAULTS,
  resolveConfig,
  embedText,
  embedBatch,
  checkOllamaHealth,
  type EmbeddingConfig,
} from '../src/services/knowledgeBase/embeddings';

// ── resolveConfig ───────────────────────────────────────────────────────────

test('resolveConfig applies all defaults when no config given', () => {
  const cfg = resolveConfig();
  expect(cfg.model).toBe('nomic-embed-text');
  expect(cfg.ollamaHost).toBe('http://localhost:11434');
  expect(cfg.dimensions).toBe(768);
});

test('resolveConfig applies defaults for missing fields', () => {
  const cfg = resolveConfig({ model: 'custom-model' });
  expect(cfg.model).toBe('custom-model');
  expect(cfg.ollamaHost).toBe('http://localhost:11434');
  expect(cfg.dimensions).toBe(768);
});

test('resolveConfig uses all provided values', () => {
  const cfg = resolveConfig({
    model: 'custom',
    ollamaHost: 'http://gpu-box:11434',
    dimensions: 1024,
  });
  expect(cfg.model).toBe('custom');
  expect(cfg.ollamaHost).toBe('http://gpu-box:11434');
  expect(cfg.dimensions).toBe(1024);
});

// ── EMBEDDING_DEFAULTS are sensible ─────────────────────────────────────────

test('EMBEDDING_DEFAULTS has expected values', () => {
  expect(EMBEDDING_DEFAULTS.model).toBe('nomic-embed-text');
  expect(EMBEDDING_DEFAULTS.dimensions).toBe(768);
  expect(EMBEDDING_DEFAULTS.ollamaHost).toContain('localhost');
});

// ── embedText with mocked fetch ─────────────────────────────────────────────

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function mockFetch(body: any, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

test('embedText calls Ollama and returns embedding', async () => {
  const fakeVec = [0.1, 0.2, 0.3];
  mockFetch({ embeddings: [fakeVec] });

  const result = await embedText('hello world', {
    ollamaHost: 'http://test-host:11434',
    model: 'test-model',
  });

  expect(result.embedding).toEqual(fakeVec);
  expect(result.model).toBe('test-model');
  expect(result.dimensions).toBe(3);

  // Verify fetch was called with correct URL and payload.
  const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
  expect(url).toBe('http://test-host:11434/api/embed');
  const body = JSON.parse(opts.body);
  expect(body.model).toBe('test-model');
  expect(body.input).toBe('hello world');
});

test('embedText throws on non-OK response', async () => {
  mockFetch({ error: 'model not found' }, 404);

  await expect(
    embedText('hello', { ollamaHost: 'http://test:11434' }),
  ).rejects.toThrow('Ollama embed failed (404)');
});

test('embedText throws on unexpected response shape', async () => {
  mockFetch({ embeddings: [] });

  await expect(
    embedText('hello', { ollamaHost: 'http://test:11434' }),
  ).rejects.toThrow('unexpected embedding response shape');
});

test('embedText strips trailing slashes from ollamaHost', async () => {
  mockFetch({ embeddings: [[0.1]] });

  await embedText('test', { ollamaHost: 'http://host:11434///' });

  const [url] = (global.fetch as jest.Mock).mock.calls[0];
  expect(url).toBe('http://host:11434/api/embed');
});

// ── embedBatch ──────────────────────────────────────────────────────────────

test('embedBatch returns empty array for empty input', async () => {
  const results = await embedBatch([]);
  expect(results).toEqual([]);
});

test('embedBatch delegates to embedText for single item', async () => {
  mockFetch({ embeddings: [[0.5, 0.5]] });

  const results = await embedBatch(['single'], {
    ollamaHost: 'http://test:11434',
    model: 'test',
  });
  expect(results.length).toBe(1);
  expect(results[0].embedding).toEqual([0.5, 0.5]);
});

test('embedBatch sends multiple texts in one request', async () => {
  mockFetch({ embeddings: [[0.1], [0.2], [0.3]] });

  const results = await embedBatch(['a', 'b', 'c'], {
    ollamaHost: 'http://test:11434',
    model: 'batch-model',
  });
  expect(results.length).toBe(3);
  expect(results[0].embedding).toEqual([0.1]);
  expect(results[2].embedding).toEqual([0.3]);

  const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
  expect(body.input).toEqual(['a', 'b', 'c']);
});

test('embedBatch throws on count mismatch', async () => {
  mockFetch({ embeddings: [[0.1]] }); // Only 1 result for 3 inputs

  await expect(
    embedBatch(['a', 'b', 'c'], { ollamaHost: 'http://test:11434' }),
  ).rejects.toThrow('1 embeddings for 3 inputs');
});

// ── checkOllamaHealth ───────────────────────────────────────────────────────

test('checkOllamaHealth returns ok:true on success', async () => {
  mockFetch({ embeddings: [[0.1, 0.2]] });

  const result = await checkOllamaHealth({ ollamaHost: 'http://test:11434' });
  expect(result.ok).toBe(true);
  expect(result.error).toBeUndefined();
});

test('checkOllamaHealth returns ok:false on network error', async () => {
  global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

  const result = await checkOllamaHealth({ ollamaHost: 'http://test:11434' });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('ECONNREFUSED');
});

test('checkOllamaHealth returns ok:false on API error', async () => {
  mockFetch({ error: 'model not found' }, 404);

  const result = await checkOllamaHealth({ ollamaHost: 'http://test:11434' });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('404');
});
