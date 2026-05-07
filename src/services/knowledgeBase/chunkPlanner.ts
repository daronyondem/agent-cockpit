import type { KbDocumentNodeRow, KbDocumentRow } from './db';

export interface KbDigestChunk {
  chunkId: string;
  rawId: string;
  nodeIds: string[];
  startUnit: number;
  endUnit: number;
  estimatedTokens: number;
  reason: 'structure' | 'split-large-node' | 'fallback';
}

export interface PlanDigestChunksOptions {
  maxUnitsPerChunk?: number;
  maxEstimatedTokensPerChunk?: number;
  unitTextLengths?: Record<number, number>;
}

const DEFAULT_MAX_UNITS_PER_CHUNK = 25;
const DEFAULT_MAX_ESTIMATED_TOKENS_PER_CHUNK = 3000;
const APPROX_CHARS_PER_TOKEN = 4;

export function planDigestChunks(
  document: KbDocumentRow,
  nodes: KbDocumentNodeRow[],
  opts: PlanDigestChunksOptions = {},
): KbDigestChunk[] {
  const maxUnits = Math.max(1, Math.floor(opts.maxUnitsPerChunk ?? DEFAULT_MAX_UNITS_PER_CHUNK));
  const unitTextLengths = opts.unitTextLengths;
  const maxEstimatedTokens = unitTextLengths || opts.maxEstimatedTokensPerChunk !== undefined
    ? Math.max(
      1,
      Math.floor(opts.maxEstimatedTokensPerChunk ?? DEFAULT_MAX_ESTIMATED_TOKENS_PER_CHUNK),
    )
    : Number.POSITIVE_INFINITY;
  const sorted = nodes
    .filter((n) => n.startUnit >= 1 && n.endUnit >= n.startUnit)
    .sort((a, b) => a.startUnit - b.startUnit || a.endUnit - b.endUnit || a.sortOrder - b.sortOrder);
  const documentEnd = Math.max(
    1,
    document.unitCount,
    sorted.reduce((max, node) => Math.max(max, node.endUnit), 0),
  );

  if (sorted.length === 0) {
    return splitRange(
      document.rawId,
      [],
      1,
      documentEnd,
      maxUnits,
      maxEstimatedTokens,
      unitTextLengths,
      'fallback',
    );
  }

  const chunks: KbDigestChunk[] = [];
  let cursor = 1;
  for (const node of sorted) {
    const nodeStart = Math.max(1, node.startUnit);
    const nodeEnd = Math.min(node.endUnit, documentEnd);
    if (nodeStart > documentEnd || nodeEnd < cursor) continue;
    if (nodeStart > cursor) {
      chunks.push(
        ...splitRange(
          document.rawId,
          [],
          cursor,
          nodeStart - 1,
          maxUnits,
          maxEstimatedTokens,
          unitTextLengths,
          'fallback',
        ),
      );
    }
    const uncoveredStart = Math.max(nodeStart, cursor);
    const reason = node.source === 'fallback' ? 'fallback' : 'structure';
    const nodeChunks = splitRange(
      document.rawId,
      [node.nodeId],
      uncoveredStart,
      nodeEnd,
      maxUnits,
      maxEstimatedTokens,
      unitTextLengths,
      reason,
    );
    chunks.push(...nodeChunks);
    cursor = nodeEnd + 1;
    if (cursor > documentEnd) break;
  }

  if (cursor <= documentEnd) {
    chunks.push(
      ...splitRange(
        document.rawId,
        [],
        cursor,
        documentEnd,
        maxUnits,
        maxEstimatedTokens,
        unitTextLengths,
        'fallback',
      ),
    );
  }

  return mergeSmallAdjacentChunks(chunks, maxUnits, maxEstimatedTokens).map((chunk, index) => ({
    ...chunk,
    chunkId: makeChunkId(index + 1, chunk.startUnit, chunk.endUnit),
  }));
}

function splitRange(
  rawId: string,
  nodeIds: string[],
  startUnit: number,
  endUnit: number,
  maxUnits: number,
  maxEstimatedTokens: number,
  unitTextLengths: Record<number, number> | undefined,
  reason: KbDigestChunk['reason'],
): KbDigestChunk[] {
  const chunks: KbDigestChunk[] = [];
  for (let start = startUnit; start <= endUnit;) {
    let end = start;
    let estimatedTokens = estimateTokens(start, end, unitTextLengths);
    while (end < endUnit && end - start + 1 < maxUnits) {
      const nextUnitTokens = estimateTokens(end + 1, end + 1, unitTextLengths);
      if (estimatedTokens + nextUnitTokens > maxEstimatedTokens) break;
      end += 1;
      estimatedTokens += nextUnitTokens;
    }
    chunks.push({
      chunkId: makeChunkId(chunks.length + 1, start, end),
      rawId,
      nodeIds,
      startUnit: start,
      endUnit: end,
      estimatedTokens,
      reason,
    });
    start = end + 1;
  }
  if (reason === 'structure' && chunks.length > 1) {
    return chunks.map((chunk) => ({ ...chunk, reason: 'split-large-node' }));
  }
  return chunks;
}

function mergeSmallAdjacentChunks(
  chunks: KbDigestChunk[],
  maxUnits: number,
  maxEstimatedTokens: number,
): KbDigestChunk[] {
  const merged: KbDigestChunk[] = [];
  for (const chunk of chunks) {
    const prev = merged[merged.length - 1];
    const wouldFit = prev
      && chunk.startUnit === prev.endUnit + 1
      && chunk.endUnit - prev.startUnit + 1 <= maxUnits
      && prev.estimatedTokens + chunk.estimatedTokens <= maxEstimatedTokens;
    if (wouldFit && prev.reason === 'structure' && chunk.reason === 'structure') {
      prev.nodeIds = [...prev.nodeIds, ...chunk.nodeIds];
      prev.endUnit = chunk.endUnit;
      prev.estimatedTokens += chunk.estimatedTokens;
    } else {
      merged.push({ ...chunk, nodeIds: [...chunk.nodeIds] });
    }
  }
  return merged;
}

function makeChunkId(index: number, startUnit: number, endUnit: number): string {
  return `chunk-${String(index).padStart(4, '0')}-u${startUnit}-${endUnit}`;
}

function estimateTokens(
  startUnit: number,
  endUnit: number,
  unitTextLengths: Record<number, number> | undefined,
): number {
  let total = 0;
  for (let unit = startUnit; unit <= endUnit; unit += 1) {
    total += estimateUnitTokens(unit, unitTextLengths);
  }
  return Math.max(1, total);
}

function estimateUnitTokens(unit: number, unitTextLengths: Record<number, number> | undefined): number {
  if (unitTextLengths && Object.prototype.hasOwnProperty.call(unitTextLengths, unit)) {
    const chars = unitTextLengths[unit];
    if (Number.isFinite(chars)) {
      return Math.max(1, Math.ceil(Math.max(0, chars) / APPROX_CHARS_PER_TOKEN));
    }
  }
  return 500;
}
