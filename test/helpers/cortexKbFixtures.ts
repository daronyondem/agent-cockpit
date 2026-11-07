import assert from 'assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createCanvas } from '@napi-rs/canvas';
import { detectPandoc } from '../../src/services/knowledgeBase/pandoc';
import { detectLibreOffice } from '../../src/services/knowledgeBase/libreOffice';

/** Native document fixtures; no shared Office profile or installation is changed. */
export async function cortexKbFixtures(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  const pandoc = await detectPandoc({ refresh: true });
  const office = await detectLibreOffice({ refresh: true });
  assert.ok(pandoc.available && pandoc.binaryPath, 'Native Pandoc is required');
  assert.ok(office.available && office.binaryPath, 'Native LibreOffice is required');
  const exec = promisify(execFile);
  const canvas = createCanvas(1200, 400); const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1200, 400); ctx.fillStyle = 'black';
  ctx.font = '48px sans-serif'; ctx.fillText('CORTEX KB 4827', 50, 95);
  ctx.font = '32px sans-serif'; ctx.fillText('Indigo release process', 50, 160);
  ctx.fillText('Every build requires a checksum manifest.', 50, 230);
  ctx.fillText('Owner: fixture maintainer', 50, 300);
  await fs.writeFile(path.join(dir, 'fixture.jpg'), canvas.toBuffer('image/jpeg'));
  await fs.writeFile(path.join(dir, 'source.md'), '# Indigo fixture\n\n![Release policy](fixture.jpg)\n');
  for (const ext of ['docx', 'pptx']) {
    await exec(pandoc.binaryPath, ['source.md', '-o', `fixture.${ext}`], { cwd: dir, timeout: 60_000 });
  }
  await exec(office.binaryPath, ['--headless', '--norestore', '--nolockcheck',
    `-env:UserInstallation=${pathToFileURL(path.join(dir, 'office-profile')).href}`,
    '--convert-to', 'pdf', '--outdir', dir, path.join(dir, 'fixture.pptx')], { cwd: dir, timeout: 120_000 });
  const files = await Promise.all(['jpg', 'pdf', 'docx', 'pptx'].map(async ext => ({
    filename: `fixture.${ext}`, buffer: await fs.readFile(path.join(dir, `fixture.${ext}`)), mimeType: {
      jpg: 'image/jpeg', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }[ext]!,
  })));
  const versions = await Promise.all([pandoc.binaryPath, office.binaryPath].map(binary => exec(binary, ['--version'], { timeout: 20_000 })));
  return { files, versions: versions.map(result => result.stdout.split('\n')[0].trim()) };
}
