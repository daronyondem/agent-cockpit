import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type {
  ContextMapDatabase,
  ContextRunSource,
  ContextSourceCursorRow,
  ContextSourceCursorType,
} from './db';

export interface ContextMapSourceChatService {
  getWorkspacePath?(hash: string): Promise<string | null>;
  getWorkspaceInstructions?(hash: string): Promise<string | null>;
}

export interface ContextMapSourcePacket {
  sourceType: ContextSourceCursorType;
  sourceId: string;
  title: string;
  body: string;
  locator: Record<string, unknown>;
  sourceHash: string;
}

export interface ContextMapWorkspaceSourceBuildResult {
  packets: ContextMapSourcePacket[];
  discoveredCursorKeys: Set<string>;
}

export interface ContextMapSourcePlanningResult {
  discoveredPackets: ContextMapSourcePacket[];
  packetsForExtraction: ContextMapSourcePacket[];
  skippedUnchanged: number;
  missingCursors: ContextSourceCursorRow[];
}

interface ContextMapCodeSourceFile {
  rel: string;
  abs: string;
  size: number;
  score: number;
}

const CONTEXT_MAP_SOURCE_CHAR_LIMIT = 12_000;
const CONTEXT_MAP_HIGH_SIGNAL_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'SPEC.md',
  'OUTLINE.md',
  'STYLE_GUIDE.md',
  'TASKS.md',
  'TODO.md',
  path.join('docs', 'SPEC.md'),
];
const CONTEXT_MAP_HIGH_SIGNAL_FILE_KEYS = new Set(
  CONTEXT_MAP_HIGH_SIGNAL_FILES.map((item) => item.split(path.sep).join('/').toLowerCase()),
);
const CONTEXT_MAP_MARKDOWN_SCAN_EXCLUDED_DIRS = new Set(['.git', 'node_modules']);
const CONTEXT_MAP_MARKDOWN_SCAN_EXCLUDED_PREFIXES = ['data/chat'];
const CONTEXT_MAP_MARKDOWN_SCAN_MAX_FILES = 120;
const CONTEXT_MAP_CODE_SCAN_EXCLUDED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.parcel-cache',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'data',
  'dist',
  'node_modules',
  'out',
  'target',
  'tmp',
  'vendor',
  'venv',
]);
const CONTEXT_MAP_CODE_SCAN_EXCLUDED_PREFIXES = ['data/chat'];
const CONTEXT_MAP_CODE_SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.go',
  '.h',
  '.hpp',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.mjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.swift',
  '.ts',
  '.tsx',
]);
const CONTEXT_MAP_CODE_SOURCE_FILENAMES = new Set([
  'cargo.toml',
  'dockerfile',
  'docker-compose.yml',
  'ecosystem.config.js',
  'go.mod',
  'next.config.js',
  'package.json',
  'pom.xml',
  'pyproject.toml',
  'requirements.txt',
  'settings.gradle',
  'tsconfig.json',
  'vite.config.js',
  'vite.config.ts',
]);
const CONTEXT_MAP_CODE_SCAN_MAX_FILES = 36;
const CONTEXT_MAP_CODE_PACKET_FILE_COUNT = 6;
const CONTEXT_MAP_CODE_FILE_MAX_BYTES = 300_000;

export async function buildWorkspaceSourcePackets(
  chatService: ContextMapSourceChatService,
  hash: string,
): Promise<ContextMapWorkspaceSourceBuildResult> {
  const packets: ContextMapSourcePacket[] = [];
  const discoveredCursorKeys = new Set<string>();
  const workspacePath = chatService.getWorkspacePath ? await chatService.getWorkspacePath(hash) : null;

  if (chatService.getWorkspaceInstructions) {
    const instructions = (await chatService.getWorkspaceInstructions(hash))?.trim();
    if (instructions) {
      const packet = sourcePacket({
        sourceType: 'workspace_instruction',
        sourceId: 'workspace-instructions',
        title: 'Workspace instructions',
        body: instructions,
        locator: { workspaceHash: hash },
      });
      packets.push(packet);
      discoveredCursorKeys.add(sourcePacketCursorKey(packet));
    }
  }

  if (workspacePath) {
    for (const rel of CONTEXT_MAP_HIGH_SIGNAL_FILES) {
      const packet = await readWorkspaceMarkdownSourcePacket(workspacePath, rel);
      if (packet) {
        packets.push(packet);
        discoveredCursorKeys.add(sourcePacketCursorKey(packet));
      }
    }

    const markdownFiles = await listWorkspaceMarkdownFiles(workspacePath);
    for (const rel of markdownFiles.discovered) discoveredCursorKeys.add(sourceCursorKey('file', rel));
    for (const rel of markdownFiles.selected) {
      const packet = await readWorkspaceMarkdownSourcePacket(workspacePath, rel);
      if (packet) {
        packets.push(packet);
        discoveredCursorKeys.add(sourcePacketCursorKey(packet));
      } else {
        discoveredCursorKeys.delete(sourceCursorKey('file', rel));
      }
    }

    for (const packet of await buildWorkspaceCodeOutlineSourcePackets(workspacePath)) {
      packets.push(packet);
      discoveredCursorKeys.add(sourcePacketCursorKey(packet));
    }
  }

  const seen = new Set<string>();
  return {
    packets: packets.filter((packet) => {
      const key = `${packet.sourceType}:${packet.sourceId}:${packet.sourceHash}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    discoveredCursorKeys,
  };
}

export function shouldDiscoverWorkspaceSources(source: ContextRunSource): boolean {
  return source === 'initial_scan' || source === 'manual_rebuild' || source === 'scheduled';
}

export function emptyWorkspaceSourcePlanning(): ContextMapSourcePlanningResult {
  return {
    discoveredPackets: [],
    packetsForExtraction: [],
    skippedUnchanged: 0,
    missingCursors: [],
  };
}

export function emptyWorkspaceSourceBuildResult(): ContextMapWorkspaceSourceBuildResult {
  return {
    packets: [],
    discoveredCursorKeys: new Set(),
  };
}

export function planWorkspaceSourcePackets(
  db: ContextMapDatabase,
  source: ContextRunSource,
  discoveredPackets: ContextMapSourcePacket[],
  discoveredCursorKeys: Set<string> = new Set(discoveredPackets.map(sourcePacketCursorKey)),
): ContextMapSourcePlanningResult {
  const missingCursors = db.listSourceCursors({ status: 'active' })
    .filter((cursor) => !discoveredCursorKeys.has(sourceCursorKey(cursor.sourceType, cursor.sourceId)));

  if (source !== 'scheduled') {
    return {
      discoveredPackets,
      packetsForExtraction: discoveredPackets,
      skippedUnchanged: 0,
      missingCursors,
    };
  }

  const packetsForExtraction = discoveredPackets.filter((packet) => {
    const cursor = db.getSourceCursor(packet.sourceType, packet.sourceId);
    return !cursor
      || cursor.status === 'missing'
      || cursor.lastProcessedSourceHash !== packet.sourceHash;
  });

  return {
    discoveredPackets,
    packetsForExtraction,
    skippedUnchanged: discoveredPackets.length - packetsForExtraction.length,
    missingCursors,
  };
}

export function formatStaleSourceCursor(cursor: ContextSourceCursorRow): Record<string, unknown> {
  return {
    sourceType: cursor.sourceType,
    sourceId: cursor.sourceId,
    previousSourceHash: cursor.lastProcessedSourceHash,
    lastProcessedAt: cursor.lastProcessedAt,
  };
}

async function listWorkspaceMarkdownFiles(workspacePath: string): Promise<{ selected: string[]; discovered: string[] }> {
  const root = path.resolve(workspacePath);
  const rels: string[] = [];

  async function visit(dir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipMarkdownScanDirectory(abs, root)) continue;
        await visit(abs);
        continue;
      }
      if (!entry.isFile() || !isMarkdownSourceFile(entry.name)) continue;
      const rel = path.relative(root, abs);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const normalizedRel = rel.split(path.sep).join('/');
      if (CONTEXT_MAP_HIGH_SIGNAL_FILE_KEYS.has(normalizedRel.toLowerCase())) continue;
      rels.push(normalizedRel);
    }
  }

  await visit(root);
  const discovered = rels
    .sort((a, b) => markdownSourceFileScore(b) - markdownSourceFileScore(a) || a.localeCompare(b));
  return {
    selected: discovered.slice(0, CONTEXT_MAP_MARKDOWN_SCAN_MAX_FILES),
    discovered,
  };
}

function markdownSourceFileScore(rel: string): number {
  const lower = rel.toLowerCase();
  const base = path.basename(lower);
  const depth = lower.split('/').length - 1;
  let score = Math.max(0, 40 - (depth * 4));
  if (CONTEXT_MAP_HIGH_SIGNAL_FILE_KEYS.has(lower)) score += 120;
  if (['readme.md', 'agents.md', 'claude.md', 'spec.md', 'outline.md', 'tasks.md', 'todo.md'].includes(base)) score += 80;
  if (lower.startsWith('docs/') || lower.startsWith('context/') || lower.startsWith('workflows/')) score += 35;
  if (lower.startsWith('projects/') || lower.startsWith('plans/') || lower.startsWith('notes/')) score += 25;
  if (lower.includes('/archive/') || lower.startsWith('archive/')) score -= 20;
  return score;
}

function shouldSkipMarkdownScanDirectory(abs: string, root: string): boolean {
  const rel = path.relative(root, abs).split(path.sep).join('/');
  const segments = rel.split('/').filter(Boolean);
  if (segments.some((segment) => CONTEXT_MAP_MARKDOWN_SCAN_EXCLUDED_DIRS.has(segment))) return true;
  return CONTEXT_MAP_MARKDOWN_SCAN_EXCLUDED_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
}

function isMarkdownSourceFile(name: string): boolean {
  return name.toLowerCase().endsWith('.md');
}

async function buildWorkspaceCodeOutlineSourcePackets(workspacePath: string): Promise<ContextMapSourcePacket[]> {
  const files = await listWorkspaceCodeSourceFiles(workspacePath);
  if (files.length === 0) return [];

  const packets: ContextMapSourcePacket[] = [];
  for (let index = 0; index < files.length; index += CONTEXT_MAP_CODE_PACKET_FILE_COUNT) {
    const chunk = files.slice(index, index + CONTEXT_MAP_CODE_PACKET_FILE_COUNT);
    const body = await buildCodeOutlineBody(chunk);
    if (!body.trim()) continue;
    const packetNumber = Math.floor(index / CONTEXT_MAP_CODE_PACKET_FILE_COUNT) + 1;
    packets.push(sourcePacket({
      sourceType: 'code_outline',
      sourceId: `code-outline/${packetNumber}`,
      title: `Code outline ${packetNumber}`,
      body,
      locator: {
        workspacePath,
        paths: chunk.map((file) => file.rel),
      },
    }));
  }
  return packets;
}

async function listWorkspaceCodeSourceFiles(workspacePath: string): Promise<ContextMapCodeSourceFile[]> {
  const root = path.resolve(workspacePath);
  const files: ContextMapCodeSourceFile[] = [];

  async function visit(dir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipCodeScanDirectory(abs, root)) continue;
        await visit(abs);
        continue;
      }
      if (!entry.isFile() || !isCodeSourceFileName(entry.name)) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (shouldSkipCodeScanFile(rel)) continue;
      let stat: import('fs').Stats;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size <= 0 || stat.size > CONTEXT_MAP_CODE_FILE_MAX_BYTES) continue;
      const score = codeSourceFileScore(rel);
      if (score <= 0) continue;
      files.push({ rel, abs, size: stat.size, score });
    }
  }

  await visit(root);
  return files
    .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
    .slice(0, CONTEXT_MAP_CODE_SCAN_MAX_FILES);
}

function shouldSkipCodeScanDirectory(abs: string, root: string): boolean {
  const rel = path.relative(root, abs).split(path.sep).join('/');
  const segments = rel.split('/').filter(Boolean);
  if (segments.some((segment) => CONTEXT_MAP_CODE_SCAN_EXCLUDED_DIRS.has(segment))) return true;
  return CONTEXT_MAP_CODE_SCAN_EXCLUDED_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
}

function shouldSkipCodeScanFile(rel: string): boolean {
  const lower = rel.toLowerCase();
  const base = path.basename(lower);
  if (base.endsWith('.min.js') || base.endsWith('.bundle.js')) return true;
  if (base.endsWith('.d.ts') || base.endsWith('.map')) return true;
  if (base.includes('lock')) return true;
  return false;
}

function isCodeSourceFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (CONTEXT_MAP_CODE_SOURCE_FILENAMES.has(lower)) return true;
  return CONTEXT_MAP_CODE_SOURCE_EXTENSIONS.has(path.extname(lower));
}

function codeSourceFileScore(rel: string): number {
  const lower = rel.toLowerCase();
  const base = path.basename(lower);
  let score = 10;
  if (CONTEXT_MAP_CODE_SOURCE_FILENAMES.has(base)) score += 80;
  if (/^(server|app|main|index)\.(c|cc|cpp|cs|go|java|js|jsx|kt|mjs|php|py|rb|rs|swift|ts|tsx)$/.test(base)) score += 70;
  if (/^src\/(server|app|main|index)\./.test(lower)) score += 60;
  if (lower.startsWith('src/routes/') || lower.startsWith('src/api/')) score += 55;
  if (lower.startsWith('src/services/') || lower.startsWith('src/lib/')) score += 50;
  if (lower.startsWith('public/') || lower.startsWith('app/') || lower.startsWith('pages/')) score += 35;
  if (lower.startsWith('mobile/')) score += 25;
  if (lower.includes('/contextmap/') || lower.includes('/context-map/')) score += 30;
  if (base.includes('service') || base.includes('manager') || base.includes('scheduler')) score += 24;
  if (base.includes('route') || base.includes('api')) score += 20;
  if (base.includes('db') || base.includes('store') || base.includes('repository')) score += 18;
  if (base.includes('screen') || base.includes('settings') || base.includes('workspace')) score += 12;
  if (lower.includes('/test/') || lower.includes('/tests/') || base.includes('.test.') || base.includes('.spec.')) score -= 35;
  return score;
}

async function buildCodeOutlineBody(files: ContextMapCodeSourceFile[]): Promise<string> {
  const sections: string[] = [
    '# Workspace code outline',
    '',
    'Generated outline of selected implementation/configuration files. File paths are evidence only; do not create entities for ordinary files, directories, functions, imports, or local code symbols.',
  ];
  for (const file of files) {
    const body = await fs.readFile(file.abs, 'utf8').catch(() => '');
    if (!body.trim()) continue;
    sections.push('', codeFileOutline(file, body));
  }
  return sections.join('\n');
}

function codeFileOutline(file: ContextMapCodeSourceFile, body: string): string {
  const lower = file.rel.toLowerCase();
  if (path.basename(lower) === 'package.json') return packageJsonOutline(file, body);
  const lines = body.split(/\r?\n/);
  const imports = uniqueLimited(lines.map(extractImportLine).filter(Boolean) as string[], 12);
  const declarations = uniqueLimited(lines.map(extractDeclarationLine).filter(Boolean) as string[], 24);
  const routes = uniqueLimited(lines.map(extractRouteLine).filter(Boolean) as string[], 24);
  const configKeys = uniqueLimited(lines.map(extractConfigKeyLine).filter(Boolean) as string[], 16);

  return [
    `## ${file.rel}`,
    `Language: ${codeLanguageForRel(file.rel)}`,
    `Size: ${file.size} bytes`,
    imports.length > 0 ? `Imports: ${imports.join('; ')}` : '',
    declarations.length > 0 ? `Declarations: ${declarations.join('; ')}` : '',
    routes.length > 0 ? `Routes/endpoints: ${routes.join('; ')}` : '',
    configKeys.length > 0 ? `Config keys: ${configKeys.join('; ')}` : '',
  ].filter(Boolean).join('\n');
}

function packageJsonOutline(file: ContextMapCodeSourceFile, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      name?: unknown;
      scripts?: unknown;
      dependencies?: unknown;
      devDependencies?: unknown;
    };
    const scripts = isRecord(parsed.scripts) ? Object.keys(parsed.scripts).sort().slice(0, 20) : [];
    const deps = isRecord(parsed.dependencies) ? Object.keys(parsed.dependencies).sort().slice(0, 24) : [];
    const devDeps = isRecord(parsed.devDependencies) ? Object.keys(parsed.devDependencies).sort().slice(0, 24) : [];
    return [
      `## ${file.rel}`,
      'Language: package manifest',
      typeof parsed.name === 'string' ? `Package name: ${parsed.name}` : '',
      scripts.length > 0 ? `Scripts: ${scripts.join(', ')}` : '',
      deps.length > 0 ? `Dependencies: ${deps.join(', ')}` : '',
      devDeps.length > 0 ? `Dev dependencies: ${devDeps.join(', ')}` : '',
    ].filter(Boolean).join('\n');
  } catch {
    return codeFileOutline({ ...file, rel: file.rel.replace(/package\.json$/i, 'package-json') }, body);
  }
}

function codeLanguageForRel(rel: string): string {
  const base = path.basename(rel).toLowerCase();
  if (CONTEXT_MAP_CODE_SOURCE_FILENAMES.has(base)) return 'configuration';
  const ext = path.extname(base).replace(/^\./, '');
  return ext || 'source';
}

function extractImportLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('//')) return null;
  if (/^import\s/.test(trimmed)) return trimmed.slice(0, 180);
  const requireMatch = trimmed.match(/require\(['"]([^'"]+)['"]\)/);
  if (requireMatch) return `require ${requireMatch[1]}`;
  return null;
}

function extractDeclarationLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) return null;
  const direct = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
  if (direct) return direct[0].replace(/\s*\{?\s*$/, '');
  const constant = trimmed.match(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/);
  if (constant && /^[A-Z]/.test(constant[1])) return constant[0].replace(/\s*=\s*$/, '');
  return null;
}

function extractRouteLine(line: string): string | null {
  const trimmed = line.trim();
  const match = trimmed.match(/\b(?:router|app)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/i);
  if (!match) return null;
  return `${match[1].toUpperCase()} ${match[2]}`;
}

function extractConfigKeyLine(line: string): string | null {
  const trimmed = line.trim();
  const match = trimmed.match(/^([A-Za-z_$][\w$-]{2,40})\s*[:=]\s*/);
  if (!match) return null;
  const key = match[1];
  if (['const', 'let', 'var', 'return', 'if', 'for', 'while', 'switch'].includes(key)) return null;
  return key;
}

function uniqueLimited(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim().replace(/\s+/g, ' ');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output;
}

async function readWorkspaceMarkdownSourcePacket(
  workspacePath: string,
  rel: string,
): Promise<ContextMapSourcePacket | null> {
  const root = path.resolve(workspacePath);
  const normalizedRel = rel.split(path.sep).join('/');
  const abs = path.resolve(workspacePath, normalizedRel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  let stat: import('fs').Stats;
  try {
    stat = await fs.stat(abs);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > 1_000_000) return null;
  const body = await fs.readFile(abs, 'utf8').catch(() => '');
  if (!body.trim()) return null;
  if (await shouldSkipWorkspaceSourceFile(normalizedRel, body, workspacePath)) return null;
  return sourcePacket({
    sourceType: 'file',
    sourceId: normalizedRel,
    title: path.basename(normalizedRel),
    body,
    locator: { path: normalizedRel, workspacePath },
  });
}

async function shouldSkipWorkspaceSourceFile(rel: string, body: string, workspacePath: string): Promise<boolean> {
  const normalizedRel = rel.split(path.sep).join('/');
  if (normalizedRel === 'CLAUDE.md' && isThinCompatibilityShim(body)) {
    return fileExists(path.resolve(workspacePath, 'AGENTS.md'));
  }
  if (normalizedRel === 'SPEC.md' && isRootSpecRedirect(body)) {
    return fileExists(path.resolve(workspacePath, 'docs', 'SPEC.md'));
  }
  return false;
}

function isThinCompatibilityShim(body: string): boolean {
  const normalized = body.toLowerCase();
  return body.length <= 2_000
    && normalized.includes('agents.md')
    && (
      normalized.includes('canonical')
      || normalized.includes('compatibility')
      || normalized.includes('imports it')
      || normalized.includes('defer')
    );
}

function isRootSpecRedirect(body: string): boolean {
  const normalized = body.toLowerCase();
  return body.length <= 5_000
    && normalized.includes('docs/spec.md')
    && (
      normalized.includes('full specification has been split')
      || normalized.includes('start here')
      || normalized.includes('wiki-style')
    );
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    const stat = await fs.stat(abs);
    return stat.isFile();
  } catch {
    return false;
  }
}

function sourcePacket(params: Omit<ContextMapSourcePacket, 'body' | 'sourceHash'> & { body: string }): ContextMapSourcePacket {
  const body = truncateSource(params.body.trim());
  return {
    ...params,
    body,
    sourceHash: sha256(stableStringify({
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      title: params.title,
      body,
    })),
  };
}

function sourcePacketCursorKey(packet: ContextMapSourcePacket): string {
  return sourceCursorKey(packet.sourceType, packet.sourceId);
}

function sourceCursorKey(sourceType: ContextSourceCursorType, sourceId: string): string {
  return `${sourceType}\u0000${sourceId}`;
}

function truncateSource(value: string): string {
  if (value.length <= CONTEXT_MAP_SOURCE_CHAR_LIMIT) return value;
  return value.slice(0, CONTEXT_MAP_SOURCE_CHAR_LIMIT) + '\n\n[truncated]';
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
