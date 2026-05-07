export function extractSourceRange(
  text: string,
  unitType: string,
  startUnit: number,
  endUnit: number,
): string | null {
  if (unitType === 'page') {
    return extractNumberedBlocks(text, 'Page', startUnit, endUnit);
  }
  if (unitType === 'slide') {
    return extractNumberedBlocks(text, 'Slide', startUnit, endUnit);
  }
  if (unitType === 'line') {
    const lines = text.split(/\r?\n/);
    return lines.slice(startUnit - 1, endUnit).join('\n');
  }
  if (unitType === 'section') {
    return extractHeadingSections(text, startUnit, endUnit);
  }
  if (startUnit === 1 && endUnit === 1) return text;
  return null;
}

export function estimateSourceUnitTextLengths(
  text: string,
  unitType: string,
  unitCount: number,
): Record<number, number> {
  const maxUnit = Math.max(1, Math.floor(unitCount));
  if (unitType === 'page') {
    return estimateBlockLengths(text, collectNumberedBlockStarts(text, 'Page'), maxUnit);
  }
  if (unitType === 'slide') {
    return estimateBlockLengths(text, collectNumberedBlockStarts(text, 'Slide'), maxUnit);
  }
  if (unitType === 'section') {
    return estimateBlockLengths(text, collectHeadingSectionStarts(text), maxUnit);
  }
  if (unitType === 'line') {
    const out: Record<number, number> = {};
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < Math.min(lines.length, maxUnit); i += 1) {
      out[i + 1] = lines[i].length;
    }
    return out;
  }
  if (maxUnit === 1) return { 1: text.length };
  return {};
}

export function extractMediaFiles(markdown: string): string[] {
  const out = new Set<string>();
  const mdImage = /!\[[^\]]*]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdImage.exec(markdown)) !== null) {
    const value = sanitizeMediaRef(match[1]);
    if (value) out.add(value);
  }
  const htmlImage = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  while ((match = htmlImage.exec(markdown)) !== null) {
    const value = sanitizeMediaRef(match[1]);
    if (value) out.add(value);
  }
  return [...out].sort();
}

function extractNumberedBlocks(
  text: string,
  label: 'Page' | 'Slide',
  startUnit: number,
  endUnit: number,
): string | null {
  const matches = collectNumberedBlockStarts(text, label);
  const start = matches.find((m) => m.unit === startUnit);
  if (!start) return null;
  const next = matches.find((m) => m.unit > endUnit);
  return text.slice(start.index, next ? next.index : text.length).trim();
}

function extractHeadingSections(text: string, startUnit: number, endUnit: number): string | null {
  const matches = collectHeadingSectionStarts(text);
  const start = matches.find((m) => m.unit === startUnit);
  if (!start) return null;
  const next = matches.find((m) => m.unit > endUnit);
  return text.slice(start.index, next ? next.index : text.length).trim();
}

function collectNumberedBlockStarts(
  text: string,
  label: 'Page' | 'Slide',
): Array<{ unit: number; index: number }> {
  const re = new RegExp(`^##\\s+${label}\\s+(\\d+)\\b.*$`, 'gim');
  const matches: Array<{ unit: number; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    matches.push({ unit: Number(match[1]), index: match.index });
  }
  return matches;
}

function collectHeadingSectionStarts(text: string): Array<{ unit: number; index: number }> {
  const re = /^#{1,6}\s+.+$/gm;
  const matches: Array<{ unit: number; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    matches.push({ unit: matches.length + 1, index: match.index });
  }
  return matches;
}

function estimateBlockLengths(
  text: string,
  starts: Array<{ unit: number; index: number }>,
  unitCount: number,
): Record<number, number> {
  const out: Record<number, number> = {};
  for (let i = 0; i < starts.length; i += 1) {
    const current = starts[i];
    if (current.unit < 1 || current.unit > unitCount) continue;
    const next = starts.slice(i + 1).find((candidate) => candidate.unit > current.unit);
    out[current.unit] = text.slice(current.index, next ? next.index : text.length).trim().length;
  }
  return out;
}

function sanitizeMediaRef(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('/')) return null;
  return trimmed;
}
