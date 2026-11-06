import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createCanvas } from '@napi-rs/canvas';
import { CORTEX_IMAGE_LIMIT, cortexPromptContent } from '../src/services/backends/cortexAttachments';
import type { AttachmentMeta } from '../src/types';

let root: string;
let image: AttachmentMeta;
const bridge = (files: AttachmentMeta[], model = 'claude-sonnet-4-6', version = '1.2.35', native = true) => cortexPromptContent('Describe attachment', files, root, model, version, native);
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-attachments-'));
  const file = path.join(root, 'fixture.png');
  await fs.writeFile(file, createCanvas(2, 2).toBuffer('image/png'));
  image = { path: file, name: 'fixture.png', kind: 'image' };
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

test('validates scoped PNG bytes and emits explicit ACP image blocks; text paths stay native-tool references', async () => {
  const blocks = await bridge([image]) as any[];
  expect(blocks[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  expect(Buffer.from(blocks[1].data, 'base64')).toEqual(await fs.readFile(image.path));
  const file = path.join(root, 'fixture.txt'); await fs.writeFile(file, 'PRIVATE_TEXT_CONTENT');
  const text = await bridge([{ name: 'fixture.txt', path: file, kind: 'text' }]);
  expect(JSON.stringify(text)).toContain('Attached file for native tools:');
  expect(JSON.stringify(text)).not.toContain('PRIVATE_TEXT_CONTENT');
  expect(await cortexPromptContent('[Uploaded files: /private/arbitrary.png]', [], undefined, 'auto', '1.2.35', false)).toEqual([{ type: 'text', text: '[Uploaded files: /private/arbitrary.png]' }]);
});

test('unverified models/versions/native transport and unsupported formats fail before reading image bytes', async () => {
  for (const [model, version, native] of [['auto', '1.2.35', true], ['other', '1.2.35', true], ['claude-sonnet-4-6', '9.0.0', true], ['claude-sonnet-4-6', '1.2.35', false]] as const) {
    await expect(bridge([image], model, version, native)).rejects.toThrow('not verified');
  }
  const jpeg = path.join(root, 'fixture.jpg'); await fs.copyFile(image.path, jpeg);
  await expect(bridge([{ ...image, path: jpeg }])).rejects.toThrow('requires PNG');
  await expect(bridge([{ ...image, kind: 'pdf' }])).rejects.toThrow('format is not supported');
  await expect(bridge(Array(11).fill(image))).rejects.toThrow('at most ten');
  await expect(cortexPromptContent('x', [image], undefined, 'claude-sonnet-4-6', '1.2.35', true)).rejects.toThrow('upload directory');
});

test('conversation isolation rejects traversal, symlinks to another conversation, missing files and directories', async () => {
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-other-upload-'));
  try {
    const file = path.join(other, 'private.png'); await fs.copyFile(image.path, file);
    await expect(bridge([{ ...image, path: file }])).rejects.toThrow('outside this conversation');
    await fs.symlink(file, path.join(root, 'link.png'));
    await expect(bridge([{ ...image, path: path.join(root, 'link.png') }])).rejects.toThrow('outside this conversation');
    await expect(bridge([{ ...image, path: path.join(root, 'missing.png') }])).rejects.toThrow('unavailable');
    const dir = path.join(root, 'folder.png'); await fs.mkdir(dir);
    await expect(bridge([{ ...image, path: dir }])).rejects.toThrow('regular files');
  } finally { await fs.rm(other, { recursive: true, force: true }); }
});

test('MIME spoofing, malformed images, per-image size and aggregate limits are enforced', async () => {
  await fs.writeFile(image.path, 'not PNG');
  await expect(bridge([image])).rejects.toThrow('invalid');
  await fs.writeFile(image.path, createCanvas(2, 2).toBuffer('image/png'));
  const handle = await fs.open(image.path, 'r+'); await handle.truncate(CORTEX_IMAGE_LIMIT + 1); await handle.close();
  await expect(bridge([image])).rejects.toThrow('5 MiB');
  // A deterministic noisy image exercises the aggregate byte limit.
  const canvas = createCanvas(1050, 1050); const context = canvas.getContext('2d');
  const pixels = context.createImageData(1050, 1050);
  let seed = 1;
  for (let i = 0; i < pixels.data.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; pixels.data[i] = seed >>> 24; }
  context.putImageData(pixels, 0, 0);
  const bytes = canvas.toBuffer('image/png');
  expect(bytes.length).toBeGreaterThan(3.5 * 1024 * 1024);
  expect(bytes.length).toBeLessThan(CORTEX_IMAGE_LIMIT);
  await fs.writeFile(image.path, bytes);
  await expect(bridge([image, image, image])).rejects.toThrow('10 MiB');
});
