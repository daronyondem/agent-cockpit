import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { loadImage } from '@napi-rs/canvas';
import type { AttachmentMeta } from '../../types';
import { cortexImageVerified } from './cortexModels';
import { CortexInputError } from './cortexErrors';

export const CORTEX_IMAGE_LIMIT = 5 * 1024 * 1024;

export function cortexPathWithin(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Only trusted attachment metadata is opened; never parse user text for paths. */
export async function cortexPromptContent(text: string, attachments: AttachmentMeta[], root: string | undefined, model: string, version: string, nativeImage: boolean): Promise<unknown[]> {
  if (attachments.length > 10) throw new CortexInputError('Cortex accepts at most ten attachments per turn.');
  const blocks: unknown[] = [{ type: 'text', text }];
  let total = 0;
  for (const attachment of attachments) {
    if (!root) throw new CortexInputError('Cortex attachments require a conversation upload directory.');
    let file: string;
    try {
      const [base, resolved] = await Promise.all([fsp.realpath(root), fsp.realpath(attachment.path)]);
      if (!cortexPathWithin(base, resolved)) throw new Error('Outside upload root');
      file = resolved;
    } catch { throw new CortexInputError('Cortex attachment is outside this conversation or unavailable.'); }
    if (attachment.kind !== 'image') {
      if (!['text', 'code', 'md'].includes(attachment.kind) || !['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.js', '.ts', '.py', '.html', '.css', '.sql', '.xml'].includes(path.extname(file).toLowerCase())) {
        throw new CortexInputError('This attachment format is not supported for Cortex input yet.');
      }
      if (!(await fsp.stat(file)).isFile()) throw new CortexInputError('Cortex attachment must be a regular file.');
      blocks.push({ type: 'text', text: `Attached file for native tools: ${JSON.stringify(file)}` });
      continue;
    }
    if (!nativeImage || !cortexImageVerified(model, version)) throw new CortexInputError('Image input is not verified for this Cortex model and CLI version.');
    if (path.extname(file).toLowerCase() !== '.png') throw new CortexInputError('Cortex image input currently requires PNG.');
    const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > CORTEX_IMAGE_LIMIT) throw new CortexInputError('Cortex images must be regular files no larger than 5 MiB.');
      const buffer = Buffer.alloc(CORTEX_IMAGE_LIMIT + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const read = await handle.read(buffer, offset, buffer.length - offset, null);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      bytes = buffer.subarray(0, offset);
    } finally { await handle.close(); }
    if (bytes.length > CORTEX_IMAGE_LIMIT || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || bytes.length < 33 || bytes.toString('ascii', 12, 16) !== 'IHDR'
      || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 20_000_000) {
      throw new CortexInputError('Cortex image is invalid or exceeds the supported limits.');
    }
    try { await loadImage(bytes); } catch { throw new CortexInputError('Cortex image is not a valid PNG.'); }
    total += bytes.length;
    if (total > 10 * 1024 * 1024) throw new CortexInputError('Cortex image input exceeds 10 MiB per turn.');
    blocks.push({ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') });
  }
  return blocks;
}
