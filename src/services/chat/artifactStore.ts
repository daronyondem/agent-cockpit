import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import type { ConversationArtifact } from '../../types';
import {
  attachmentKindFromPath,
  extensionForMimeType,
  mimeTypeFromPath,
  sanitizeArtifactFilename,
  splitDataUrlBase64,
} from './attachments';

export interface CreateConversationArtifactInput {
  sourcePath?: string;
  dataBase64?: string;
  filename?: string;
  mimeType?: string;
  title?: string;
  sourceToolId?: string | null;
}

interface ArtifactStoreDeps {
  artifactsDir: string;
  hasConversation(convId: string): boolean;
}

export class ArtifactStore {
  constructor(private readonly deps: ArtifactStoreDeps) {}

  async createConversationArtifact(
    convId: string,
    input: CreateConversationArtifactInput,
  ): Promise<ConversationArtifact | null> {
    if (!this.deps.hasConversation(convId)) return null;
    const convDir = path.join(this.deps.artifactsDir, convId);
    await fsp.mkdir(convDir, { recursive: true });

    let sourcePath = input.sourcePath ? path.resolve(input.sourcePath) : '';
    let bytes: Buffer | null = null;
    let size: number | undefined;
    let mimeType = input.mimeType;

    if (input.dataBase64) {
      const parsed = splitDataUrlBase64(input.dataBase64, mimeType);
      mimeType = parsed.mimeType || mimeType;
      bytes = Buffer.from(parsed.dataBase64.replace(/\s+/g, ''), 'base64');
      size = bytes.length;
    } else if (sourcePath) {
      const stat = await fsp.stat(sourcePath);
      if (!stat.isFile()) {
        throw new Error('Artifact source path is not a file');
      }
      size = stat.size;
      mimeType = mimeType || mimeTypeFromPath(sourcePath);
    } else {
      throw new Error('Artifact sourcePath or dataBase64 is required');
    }

    const requestedName = input.filename
      || (sourcePath ? path.basename(sourcePath) : '')
      || `artifact${extensionForMimeType(mimeType)}`;
    let safeName = sanitizeArtifactFilename(requestedName);
    if (!path.extname(safeName)) {
      safeName += extensionForMimeType(mimeType);
    }

    const ext = path.extname(safeName);
    const stem = ext ? safeName.slice(0, -ext.length) : safeName;
    let dest = path.join(convDir, safeName);
    let counter = 1;
    while (fs.existsSync(dest) && (!sourcePath || path.resolve(dest) !== sourcePath)) {
      safeName = `${stem}-${counter}${ext}`;
      dest = path.join(convDir, safeName);
      counter += 1;
    }

    if (bytes) {
      await fsp.writeFile(dest, bytes);
    } else if (sourcePath && path.resolve(dest) !== sourcePath) {
      await fsp.copyFile(sourcePath, dest);
    }

    const finalStat = await fsp.stat(dest);
    return {
      filename: path.basename(dest),
      path: dest,
      kind: attachmentKindFromPath(dest),
      size: finalStat.size || size,
      mimeType: mimeType || mimeTypeFromPath(dest),
      title: input.title,
      sourceToolId: input.sourceToolId ?? null,
    };
  }
}
