/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Per-image AI conversion tests ──────────────────────────────────────────
// `convertImageToMarkdown` is a thin retry-once wrapper over a stubbed
// `BaseBackendAdapter.runOneShot`. We verify:
//   - Happy path returns adapter output verbatim
//   - Retry-once on throw, then succeed
//   - Retry-once on empty output, then succeed
//   - Two failures throws the last error
//   - Two empty outputs throws an error
//   - Prompt references the image by basename
//   - workingDir is set to the image's parent directory
//   - allowTools is true (so the CLI can use Read on the image)

import path from 'path';
import {
  BaseBackendAdapter,
  type RunOneShotOptions,
} from '../src/services/backends/base';
import {
  convertImageToMarkdown,
  IMAGE_TO_MARKDOWN_PROMPT_TEMPLATE,
} from '../src/services/knowledgeBase/ingestion/pageConversion';

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
  test('returns adapter output on first success', async () => {
    const adapter = new StubAdapter(async () => '# Page 42\n\nHello world.');

    const result = await convertImageToMarkdown(IMAGE_PATH, { adapter });

    expect(result).toBe('# Page 42\n\nHello world.');
    expect(adapter.calls).toHaveLength(1);
  });

  test('retries once on throw and returns second success', async () => {
    let callCount = 0;
    const adapter = new StubAdapter(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('CLI crashed');
      return '# Page 42';
    });

    const result = await convertImageToMarkdown(IMAGE_PATH, { adapter });

    expect(result).toBe('# Page 42');
    expect(adapter.calls).toHaveLength(2);
  });

  test('retries once on empty output and returns second success', async () => {
    let callCount = 0;
    const adapter = new StubAdapter(async () => {
      callCount += 1;
      return callCount === 1 ? '   \n\t  ' : '# Page 42';
    });

    const result = await convertImageToMarkdown(IMAGE_PATH, { adapter });

    expect(result).toBe('# Page 42');
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

  test('default timeout is 3 minutes when not specified', async () => {
    const adapter = new StubAdapter(async () => 'ok');

    await convertImageToMarkdown(IMAGE_PATH, { adapter });

    expect(adapter.calls[0].opts?.timeoutMs).toBe(3 * 60_000);
  });
});
