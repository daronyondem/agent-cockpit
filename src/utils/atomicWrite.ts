import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

/**
 * Write a file atomically: write to a sibling temp path, then rename.
 * `rename(2)` is atomic on POSIX, so a reader always sees either the
 * previous complete file or the new complete file — never a torn write,
 * and never a zero-byte file produced by a crash mid-write.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Buffer,
  encoding: BufferEncoding = 'utf8',
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);

  try {
    if (typeof data === 'string') {
      await fsp.writeFile(tmpPath, data, encoding);
    } else {
      await fsp.writeFile(tmpPath, data);
    }
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    try { await fsp.unlink(tmpPath); } catch { /* tmp may not exist */ }
    throw err;
  }
}
