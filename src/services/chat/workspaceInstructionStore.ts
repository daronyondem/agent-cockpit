import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { SUPPORTED_CLI_VENDORS } from '../cliProfiles';
import {
  type CliVendor,
  type WorkspaceIndex,
  type WorkspaceInstructionCompatibilityStatus,
  type WorkspaceInstructionPointerResult,
  type WorkspaceInstructionSourceId,
  type WorkspaceInstructionSourceStatus,
  type WorkspaceInstructionVendorStatus,
} from '../../types';

interface WorkspaceInstructionStoreDeps {
  indexLock: { run<T>(key: string, fn: () => Promise<T>): Promise<T> };
  readWorkspaceIndex(hash: string): Promise<WorkspaceIndex | null>;
  writeWorkspaceIndex(hash: string, index: WorkspaceIndex): Promise<void>;
}

const INSTRUCTION_SOURCE_ORDER: WorkspaceInstructionSourceId[] = ['agents', 'claude', 'kiro'];

const INSTRUCTION_SOURCE_META: Record<WorkspaceInstructionSourceId, {
  vendor: CliVendor;
  label: string;
  expectedPath: string;
}> = {
  agents: { vendor: 'codex', label: 'AGENTS.md', expectedPath: 'AGENTS.md' },
  claude: { vendor: 'claude-code', label: 'CLAUDE.md', expectedPath: 'CLAUDE.md' },
  kiro: { vendor: 'kiro', label: 'Kiro steering', expectedPath: '.kiro/steering/agents-md.md' },
};

const INSTRUCTION_VENDOR_LABELS: Record<CliVendor, string> = {
  'claude-code': 'Claude Code',
  kiro: 'Kiro',
  codex: 'Codex',
};

const VENDOR_INSTRUCTION_SOURCE: Record<CliVendor, WorkspaceInstructionSourceId> = {
  codex: 'agents',
  'claude-code': 'claude',
  kiro: 'kiro',
};

function relPath(absPath: string, workspacePath: string): string {
  return path.relative(workspacePath, absPath).split(path.sep).join('/');
}

function sortInstructionPaths(paths: string[]): string[] {
  return [...paths].sort((a, b) => a.localeCompare(b));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function listKiroSteeringFiles(workspacePath: string): Promise<string[]> {
  const steeringDir = path.join(workspacePath, '.kiro', 'steering');
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(relPath(abs, workspacePath));
      }
    }
  }

  await walk(steeringDir);
  return sortInstructionPaths(out);
}

function instructionFingerprint(
  sources: WorkspaceInstructionSourceStatus[],
  missingVendors: WorkspaceInstructionVendorStatus[],
): string {
  const payload = {
    sources: sources
      .filter(source => source.present)
      .map(source => ({ id: source.id, paths: source.paths })),
    missingVendors: missingVendors.map(item => item.vendor),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function formatInstructionLinkList(paths: string[]): string {
  return paths.map(p => `- [${p}](${p})`).join('\n');
}

function agentsPointerContent(sources: WorkspaceInstructionSourceStatus[]): string {
  const existingPaths = sources
    .filter(source => source.present && source.id !== 'agents')
    .flatMap(source => source.paths);
  const lines = [
    '# Agent Instructions',
    '',
    existingPaths.length
      ? 'Read and follow the existing project instruction file(s):'
      : 'This workspace uses Agent Cockpit project instructions.',
    '',
  ];
  if (existingPaths.length) {
    lines.push(formatInstructionLinkList(existingPaths), '');
  }
  lines.push(
    'This file lets CLI coding agents that read AGENTS.md reuse the existing project instructions.',
    '',
  );
  return lines.join('\n');
}

function claudePointerContent(): string {
  return [
    '# Claude Code Instructions',
    '',
    '@AGENTS.md',
    '',
    'This file is intentionally thin. `AGENTS.md` is the canonical cross-agent instruction file for this workspace; Claude Code imports it here for compatibility with Claude Code project-memory lookup.',
    '',
  ].join('\n');
}

function kiroPointerContent(): string {
  return [
    '---',
    'inclusion: always',
    '---',
    '',
    '#[[file:AGENTS.md]]',
    '',
  ].join('\n');
}

async function writePointerFile(workspacePath: string, relativePath: string, content: string): Promise<boolean> {
  const abs = path.join(workspacePath, relativePath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  try {
    await fsp.writeFile(abs, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export class WorkspaceInstructionStore {
  constructor(private readonly deps: WorkspaceInstructionStoreDeps) {}

  async getInstructions(hash: string): Promise<string | null> {
    const index = await this.deps.readWorkspaceIndex(hash);
    if (!index) return null;
    return index.instructions || '';
  }

  async setInstructions(hash: string, instructions: string): Promise<string | null> {
    return this.deps.indexLock.run(hash, async () => {
      const index = await this.deps.readWorkspaceIndex(hash);
      if (!index) return null;
      index.instructions = instructions || '';
      await this.deps.writeWorkspaceIndex(hash, index);
      return index.instructions;
    });
  }

  async getCompatibility(hash: string): Promise<WorkspaceInstructionCompatibilityStatus | null> {
    const index = await this.deps.readWorkspaceIndex(hash);
    if (!index) return null;
    return this.detectCompatibility(hash, index);
  }

  async createPointers(hash: string): Promise<{
    status: WorkspaceInstructionCompatibilityStatus;
    created: WorkspaceInstructionPointerResult[];
  } | null> {
    return this.deps.indexLock.run(hash, async () => {
      const index = await this.deps.readWorkspaceIndex(hash);
      if (!index) return null;

      const status = await this.detectCompatibility(hash, index);
      const created: WorkspaceInstructionPointerResult[] = [];
      if (!status.canCreatePointers) {
        return { status, created };
      }

      const missing = new Set(status.missingVendors.map(item => item.vendor));
      const workspacePath = index.workspacePath;

      if (missing.has('codex')) {
        const source = INSTRUCTION_SOURCE_META.agents;
        if (await writePointerFile(workspacePath, source.expectedPath, agentsPointerContent(status.sources))) {
          created.push({ vendor: source.vendor, label: source.label, path: source.expectedPath });
        }
      }

      if (missing.has('claude-code')) {
        const source = INSTRUCTION_SOURCE_META.claude;
        if (await writePointerFile(workspacePath, source.expectedPath, claudePointerContent())) {
          created.push({ vendor: source.vendor, label: source.label, path: source.expectedPath });
        }
      }

      if (missing.has('kiro')) {
        const source = INSTRUCTION_SOURCE_META.kiro;
        if (await writePointerFile(workspacePath, source.expectedPath, kiroPointerContent())) {
          created.push({ vendor: source.vendor, label: source.label, path: source.expectedPath });
        }
      }

      if (index.instructionCompatibilityDismissedFingerprint) {
        delete index.instructionCompatibilityDismissedFingerprint;
        await this.deps.writeWorkspaceIndex(hash, index);
      }

      const nextStatus = await this.detectCompatibility(hash, index);
      return { status: nextStatus, created };
    });
  }

  async dismissCompatibility(hash: string): Promise<WorkspaceInstructionCompatibilityStatus | null> {
    return this.deps.indexLock.run(hash, async () => {
      const index = await this.deps.readWorkspaceIndex(hash);
      if (!index) return null;
      const status = await this.detectCompatibility(hash, index);
      index.instructionCompatibilityDismissedFingerprint = status.fingerprint;
      await this.deps.writeWorkspaceIndex(hash, index);
      return this.detectCompatibility(hash, index);
    });
  }

  private async detectCompatibility(
    hash: string,
    index: WorkspaceIndex,
  ): Promise<WorkspaceInstructionCompatibilityStatus> {
    const workspacePath = index.workspacePath;
    const agentsPresent = await fileExists(path.join(workspacePath, 'AGENTS.md'));
    const claudePresent = await fileExists(path.join(workspacePath, 'CLAUDE.md'));
    const kiroPaths = await listKiroSteeringFiles(workspacePath);

    const sources: WorkspaceInstructionSourceStatus[] = INSTRUCTION_SOURCE_ORDER.map(id => {
      const meta = INSTRUCTION_SOURCE_META[id];
      const paths = id === 'agents'
        ? (agentsPresent ? ['AGENTS.md'] : [])
        : id === 'claude'
          ? (claudePresent ? ['CLAUDE.md'] : [])
          : kiroPaths;
      return {
        id,
        vendor: meta.vendor,
        label: meta.label,
        expectedPath: meta.expectedPath,
        present: paths.length > 0,
        paths,
      };
    });

    const bySource = new Map(sources.map(source => [source.id, source]));
    const vendors: WorkspaceInstructionVendorStatus[] = SUPPORTED_CLI_VENDORS.map(vendor => {
      const sourceId = VENDOR_INSTRUCTION_SOURCE[vendor];
      const source = bySource.get(sourceId)!;
      return {
        vendor,
        label: INSTRUCTION_VENDOR_LABELS[vendor],
        sourceId,
        expectedPath: source.expectedPath,
        covered: source.present,
      };
    });
    const missingVendors = vendors.filter(item => !item.covered);
    const hasAnyInstructions = sources.some(source => source.present);
    const compatible = !hasAnyInstructions || missingVendors.length === 0;
    const fingerprint = instructionFingerprint(sources, missingVendors);
    const dismissed = index.instructionCompatibilityDismissedFingerprint === fingerprint;
    const primarySource = sources.find(source => source.id === 'agents' && source.present)
      || sources.find(source => source.present)
      || null;

    return {
      workspaceHash: hash,
      workspacePath,
      sources,
      vendors,
      missingVendors,
      hasAnyInstructions,
      compatible,
      canCreatePointers: hasAnyInstructions && missingVendors.length > 0,
      fingerprint,
      dismissed,
      shouldNotify: hasAnyInstructions && missingVendors.length > 0 && !dismissed,
      primarySourceId: primarySource ? primarySource.id : null,
    };
  }
}
