import type { KbDocumentNodeRow, KbDocumentUnitType, UpsertDocumentStructureParams } from './db';

export interface BuildDocumentStructureInput {
  rawId: string;
  filename: string;
  text: string;
  metadata?: Record<string, unknown> | null;
  now?: string;
}

interface StructureCandidate {
  unitType: KbDocumentUnitType;
  unitCount: number;
  nodes: KbDocumentNodeRow[];
}

export function buildDocumentStructure(input: BuildDocumentStructureInput): UpsertDocumentStructureParams {
  const now = input.now ?? new Date().toISOString();
  const metadata = input.metadata ?? {};
  const docName = input.filename || input.rawId;
  const candidate =
    buildNumberedBlockStructure(input.rawId, input.text, 'page', 'Page', numberFromMetadata(metadata.pageCount)) ??
    buildNumberedBlockStructure(input.rawId, input.text, 'slide', 'Slide', numberFromMetadata(metadata.slideCount)) ??
    buildHeadingStructure(input.rawId, input.text) ??
    buildFallbackStructure(input.rawId, docName, metadata);

  return {
    document: {
      rawId: input.rawId,
      docName,
      docDescription: null,
      unitType: candidate.unitType,
      unitCount: candidate.unitCount,
      structureStatus: 'ready',
      structureError: null,
      createdAt: now,
      updatedAt: now,
    },
    nodes: candidate.nodes,
  };
}

function buildNumberedBlockStructure(
  rawId: string,
  text: string,
  unitType: 'page' | 'slide',
  label: 'Page' | 'Slide',
  metadataCount: number | null,
): StructureCandidate | null {
  const re = new RegExp(`^##\\s+${label}\\s+(\\d+)\\b.*$`, 'gim');
  const nodes: KbDocumentNodeRow[] = [];
  const seen = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const n = Number(match[1]);
    if (!Number.isInteger(n) || n < 1 || seen.has(n)) continue;
    seen.add(n);
    nodes.push({
      nodeId: `${unitType}-${n}`,
      rawId,
      parentNodeId: null,
      title: `${label} ${n}`,
      summary: null,
      startUnit: n,
      endUnit: n,
      sortOrder: n,
      source: 'deterministic',
      metadata: undefined,
    });
  }
  if (nodes.length === 0) return null;
  nodes.sort((a, b) => a.startUnit - b.startUnit);
  const maxUnit = Math.max(...nodes.map((n) => n.endUnit), metadataCount ?? 0);
  return { unitType, unitCount: maxUnit, nodes };
}

function buildHeadingStructure(rawId: string, text: string): StructureCandidate | null {
  const lines = text.split(/\r?\n/);
  const nodes: KbDocumentNodeRow[] = [];
  const stack: Array<{ level: number; nodeId: string }> = [];
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const level = match[1].length;
    const title = stripMarkdownHeadingTail(match[2]);
    if (!title) continue;
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    const index = nodes.length + 1;
    const nodeId = `section-${index}`;
    nodes.push({
      nodeId,
      rawId,
      parentNodeId: stack.length > 0 ? stack[stack.length - 1].nodeId : null,
      title,
      summary: null,
      startUnit: index,
      endUnit: index,
      sortOrder: index,
      source: 'deterministic',
      metadata: { headingLevel: level },
    });
    stack.push({ level, nodeId });
  }
  if (nodes.length === 0) return null;
  return { unitType: 'section', unitCount: nodes.length, nodes };
}

function buildFallbackStructure(
  rawId: string,
  docName: string,
  metadata: Record<string, unknown>,
): StructureCandidate {
  const pageCount = numberFromMetadata(metadata.pageCount);
  const slideCount = numberFromMetadata(metadata.slideCount);
  const unitType: KbDocumentUnitType = pageCount ? 'page' : slideCount ? 'slide' : 'unknown';
  const unitCount = pageCount ?? slideCount ?? 1;
  return {
    unitType,
    unitCount,
    nodes: [
      {
        nodeId: 'root',
        rawId,
        parentNodeId: null,
        title: docName,
        summary: null,
        startUnit: 1,
        endUnit: unitCount,
        sortOrder: 0,
        source: 'fallback',
        metadata: undefined,
      },
    ],
  };
}

function numberFromMetadata(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function stripMarkdownHeadingTail(title: string): string {
  return title.replace(/\s+#+\s*$/, '').trim();
}
