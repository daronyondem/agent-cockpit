export interface ClaudeTerminalQueryOptions {
  rows?: number;
  cols?: number;
  terminalName?: string;
}

const ESC = '\x1b';
const DEFAULT_ROWS = 40;
const DEFAULT_COLS = 120;

export function collectClaudeTerminalResponses(
  data: string | Buffer,
  options: ClaudeTerminalQueryOptions = {},
): string[] {
  const text = typeof data === 'string' ? data : data.toString('utf8');
  const rows = normalizeDimension(options.rows, DEFAULT_ROWS);
  const cols = normalizeDimension(options.cols, DEFAULT_COLS);
  const terminalName = sanitizeTerminalName(options.terminalName || 'AgentCockpit');
  const responses: string[] = [];

  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 0x1b || text[i + 1] !== '[') continue;
    let j = i + 2;
    const privateGt = text[j] === '>';
    if (privateGt) j += 1;
    const paramsStart = j;
    while (j < text.length && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x3f) j += 1;
    while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j += 1;
    if (j >= text.length) break;

    const final = text[j];
    const params = text.slice(paramsStart, j);
    if (final === 'c') {
      responses.push(privateGt ? `${ESC}[>0;0;0c` : `${ESC}[?1;2c`);
    } else if (final === 'n' && params === '6') {
      responses.push(`${ESC}[1;1R`);
    } else if (final === 'q' && privateGt) {
      responses.push(`${ESC}P>|${terminalName}${ESC}\\`);
    } else if (final === 't' && params === '18') {
      responses.push(`${ESC}[8;${rows};${cols}t`);
    }
    i = j;
  }

  return responses;
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value) return fallback;
  return Math.max(1, Math.floor(value));
}

function sanitizeTerminalName(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) || 'AgentCockpit';
}

