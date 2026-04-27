/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Per-image AI conversion + downscaling tests ────────────────────────────
// Two units under test:
//
//   `convertImageToMarkdown`: thin retry-once wrapper over a stubbed
//   `BaseBackendAdapter.runOneShot`. We verify happy path, retry-once on
//   throw / empty output, two-failure throws, prompt+workingDir+allowTools
//   plumbing, and option passthrough.
//
//   `ensureAiReadyImage`: writes a downscaled `.ai.png` sibling beside an
//   oversized image and returns the new path; passes through small/undecodable
//   images. Handlers call this BEFORE `convertImageToMarkdown` and rewrite the
//   markdown link, so the same downscaled file serves both ingestion-time AI
//   and digestion-time CLI reads.

import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';
import * as napiCanvas from '@napi-rs/canvas';
import {
  BaseBackendAdapter,
  type RunOneShotOptions,
} from '../src/services/backends/base';
import {
  convertImageToMarkdown,
  ensureAiReadyImage,
  IMAGE_TO_MARKDOWN_PROMPT_TEMPLATE,
  MAX_LONG_EDGE_PX,
} from '../src/services/knowledgeBase/ingestion/pageConversion';

async function writePng(filePath: string, width: number, height: number): Promise<void> {
  const canvas = napiCanvas.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#cccccc';
  ctx.fillRect(0, 0, width, height);
  await fsp.writeFile(filePath, canvas.toBuffer('image/png'));
}

type RunOneShotFn = (prompt: string, opts?: RunOneShotOptions) => Promise<string>;

class StubAdapter extends BaseBackendAdapter {
  public calls: Array<{ prompt: string; opts?: RunOneShotOptions }> = [];
  constructor(private readonly impl: RunOneShotFn) {
    super();
  }
  async runOneShot(prompt: string, opts?: RunOneShotOptions): Promise<string> {
    this.calls.push({ prompt, opts });
    return this.impl(prompt, opts);
  }
}

const IMAGE_PATH = '/tmp/raw-abc/pages/page-0042.png';

describe('convertImageToMarkdown', () => {
  test('returns markdown with retried=false on first success', async () => {
    const adapter = new StubAdapter(async () => '# Page 42\n\nHello world.');

    const result = await convertImageToMarkdown(IMAGE_PATH, { adapter });

    expect(result.markdown).toBe('# Page 42\n\nHello world.');
    expect(result.retried).toBe(false);
    expect(adapter.calls).toHaveLength(1);
  });

  test('retries once on throw and returns retried=true on second success', async () => {
    let callCount = 0;
    const adapter = new StubAdapter(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('CLI crashed');
      return '# Page 42';
    });

    const result = await convertImageToMarkdown(IMAGE_PATH, { adapter });

    expect(result.markdown).toBe('# Page 42');
    expect(result.retried).toBe(true);
    expect(adapter.calls).toHaveLength(2);
  });

  test('retries once on empty output and returns retried=true on second success', async () => {
    let callCount = 0;
    const adapter = new StubAdapter(async () => {
      callCount += 1;
      return callCount === 1 ? '   \n\t  ' : '# Page 42';
    });

    const result = await convertImageToMarkdown(IMAGE_PATH, { adapter });

    expect(result.markdown).toBe('# Page 42');
    expect(result.retried).toBe(true);
    expect(adapter.calls).toHaveLength(2);
  });

  test('throws the last error after two consecutive throws', async () => {
    let callCount = 0;
    const adapter = new StubAdapter(async () => {
      callCount += 1;
      throw new Error(`attempt ${callCount} failed`);
    });

    await expect(
      convertImageToMarkdown(IMAGE_PATH, { adapter }),
    ).rejects.toThrow('attempt 2 failed');
    expect(adapter.calls).toHaveLength(2);
  });

  test('throws when both attempts return empty output', async () => {
    const adapter = new StubAdapter(async () => '   ');

    await expect(
      convertImageToMarkdown(IMAGE_PATH, { adapter }),
    ).rejects.toThrow(/empty output/i);
    expect(adapter.calls).toHaveLength(2);
  });

  test('prompt references the image by basename', async () => {
    const adapter = new StubAdapter(async () => 'ok');

    await convertImageToMarkdown(IMAGE_PATH, { adapter });

    const { prompt } = adapter.calls[0];
    expect(prompt).toContain('page-0042.png');
    expect(prompt).not.toContain(IMAGE_PATH);
  });

  test('prompt template matches design §8 unified prompt', async () => {
    const prompt = IMAGE_TO_MARKDOWN_PROMPT_TEMPLATE('foo.png');
    expect(prompt).toContain('foo.png');
    expect(prompt).toMatch(/Markdown tables/);
    expect(prompt).toMatch(/figures, charts, diagrams/);
    expect(prompt).toMatch(/visible text accurately/);
    expect(prompt).toMatch(/Output Markdown only/);
  });

  test('sets workingDir to the image parent directory and allowTools=true', async () => {
    const adapter = new StubAdapter(async () => 'ok');

    await convertImageToMarkdown(IMAGE_PATH, { adapter });

    const { opts } = adapter.calls[0];
    expect(opts?.workingDir).toBe(path.dirname(IMAGE_PATH));
    expect(opts?.allowTools).toBe(true);
  });

  test('passes model/effort/timeoutMs through to the adapter', async () => {
    const adapter = new StubAdapter(async () => 'ok');

    await convertImageToMarkdown(IMAGE_PATH, {
      adapter,
      model: 'claude-sonnet-4-6',
      effort: 'high',
      timeoutMs: 60_000,
    });

    const { opts } = adapter.calls[0];
    expect(opts?.model).toBe('claude-sonnet-4-6');
    expect(opts?.effort).toBe('high');
    expect(opts?.timeoutMs).toBe(60_000);
  });

  test('default timeout is 10 minutes when not specified', async () => {
    const adapter = new StubAdapter(async () => 'ok');

    await convertImageToMarkdown(IMAGE_PATH, { adapter });

    expect(adapter.calls[0].opts?.timeoutMs).toBe(10 * 60_000);
  });
});

describe('ensureAiReadyImage', () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-pc-test-'));
  });
  afterEach(async () => {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test('writes a downscaled PNG sibling and returns its path when long edge exceeds the cap', async () => {
    const src = path.join(workDir, 'huge.png');
    const dest = src + '.ai.png';
    await writePng(src, 3000, 2000);

    const result = await ensureAiReadyImage(src, dest);

    expect(result).toBe(dest);
    await expect(fsp.access(dest)).resolves.toBeUndefined();
    const downscaled = await napiCanvas.loadImage(dest);
    expect(downscaled.width).toBe(MAX_LONG_EDGE_PX);
    expect(downscaled.height).toBe(Math.round(2000 * (MAX_LONG_EDGE_PX / 3000)));
    // Original is left untouched.
    const original = await napiCanvas.loadImage(src);
    expect(original.width).toBe(3000);
    expect(original.height).toBe(2000);
  });

  test('returns the source path with no write when the image fits the cap', async () => {
    const src = path.join(workDir, 'small.png');
    const dest = src + '.ai.png';
    await writePng(src, 800, 600);

    const result = await ensureAiReadyImage(src, dest);

    expect(result).toBe(src);
    await expect(fsp.access(dest)).rejects.toThrow();
  });

  test('returns the source path with no write when long edge is exactly the cap', async () => {
    const src = path.join(workDir, 'edge.png');
    const dest = src + '.ai.png';
    await writePng(src, MAX_LONG_EDGE_PX, 100);

    const result = await ensureAiReadyImage(src, dest);

    expect(result).toBe(src);
    await expect(fsp.access(dest)).rejects.toThrow();
  });

  test('falls through to the source path when the image cannot be decoded', async () => {
    const src = '/tmp/no-such-dir/missing.png';
    const dest = '/tmp/no-such-dir/missing.png.ai.png';

    const result = await ensureAiReadyImage(src, dest);

    expect(result).toBe(src);
    await expect(fsp.access(dest)).rejects.toThrow();
  });

  test('creates the destination parent directory if it does not exist', async () => {
    const src = path.join(workDir, 'huge.png');
    const dest = path.join(workDir, 'nested', 'sub', 'huge.png.ai.png');
    await writePng(src, 3000, 2000);

    const result = await ensureAiReadyImage(src, dest);

    expect(result).toBe(dest);
    await expect(fsp.access(dest)).resolves.toBeUndefined();
  });
});
