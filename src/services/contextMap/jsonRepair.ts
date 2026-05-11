import type { RunOneShotOptions } from '../backends/base';

export type ContextMapJsonRepairSchema = 'extraction' | 'synthesis' | 'arbiter';

export const CONTEXT_MAP_JSON_REPAIR_TIMEOUT_MS = 90_000;
const CONTEXT_MAP_JSON_REPAIR_OUTPUT_CHAR_LIMIT = 16_000;

export type ContextMapJsonRepairRunOneShot = (
  prompt: string,
  options: RunOneShotOptions,
  abortSignal: AbortSignal,
) => Promise<string>;

export interface ContextMapJsonRepairProcessor {
  model?: string;
  effort?: RunOneShotOptions['effort'];
  cliProfile?: RunOneShotOptions['cliProfile'];
}

export function extractJsonObject(raw: string): string | null {
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith('{')) return inner;
  }
  return scanBalancedObject(raw);
}

export function parseContextMapJsonOutput(rawOutput: string, noJsonMessage: string, invalidJsonPrefix: string): unknown {
  const json = extractJsonObject(rawOutput);
  if (!json) throw new Error(noJsonMessage);
  try {
    return JSON.parse(json) as unknown;
  } catch (err: unknown) {
    const repaired = insertMissingCommasBetweenArrayValues(json);
    if (repaired !== json) {
      try {
        return JSON.parse(repaired) as unknown;
      } catch {
        // Preserve the original parser error so diagnostics point at the model output.
      }
    }
    throw new Error(`${invalidJsonPrefix}: ${(err as Error).message}`);
  }
}

export async function repairContextMapJsonOutput(opts: {
  rawOutput: string;
  errorMessage: string;
  schema: ContextMapJsonRepairSchema;
  runOneShot: ContextMapJsonRepairRunOneShot;
  processor: ContextMapJsonRepairProcessor;
  abortSignal: AbortSignal;
  workspacePath: string | undefined;
}): Promise<string> {
  const repairedOutput = await opts.runOneShot(buildContextMapJsonRepairPrompt({
    rawOutput: opts.rawOutput,
    errorMessage: opts.errorMessage,
    schema: opts.schema,
  }), {
    model: opts.processor.model,
    effort: opts.processor.effort,
    timeoutMs: CONTEXT_MAP_JSON_REPAIR_TIMEOUT_MS,
    abortSignal: opts.abortSignal,
    workingDir: opts.workspacePath,
    allowTools: false,
    cliProfile: opts.processor.cliProfile,
  } satisfies RunOneShotOptions, opts.abortSignal);
  if (opts.abortSignal.aborted) throw new Error('Context Map scan stopped');
  return repairedOutput;
}

export function buildContextMapJsonRepairPrompt(opts: {
  rawOutput: string;
  errorMessage: string;
  schema: ContextMapJsonRepairSchema;
}): string {
  const expectedShape = opts.schema === 'extraction'
    ? '{"candidates":[{"type":"new_entity","confidence":0.85,"payload":{"typeSlug":"workflow","name":"Example workflow","summaryMarkdown":"Short durable summary."}}]}'
    : opts.schema === 'synthesis'
      ? '{"candidates":[{"sourceRefs":["candidate-1"],"type":"new_entity","confidence":0.88,"payload":{"typeSlug":"project","name":"Example","summaryMarkdown":"Short durable summary."}}],"dropped":[],"openQuestions":[]}'
      : '{"keepRefs":["candidate-1"],"dropRefs":[],"mergeGroups":[],"typeCorrections":[],"relationshipToFactRefs":[],"openQuestions":[]}';
  return [
    'You are the Context Map JSON repair processor.',
    '',
    'Repair malformed JSON from a prior Context Map response.',
    'Output a single valid JSON object only. Do not include markdown or prose.',
    'Preserve the prior response semantics as much as possible. Do not invent new candidates, refs, facts, entities, evidence, or secrets.',
    'If a malformed item cannot be repaired confidently, omit only that item.',
    '',
    'Expected JSON shape:',
    expectedShape,
    '',
    'Parser error:',
    opts.errorMessage,
    '',
    'Malformed output:',
    compactPromptBlock(opts.rawOutput, CONTEXT_MAP_JSON_REPAIR_OUTPUT_CHAR_LIMIT),
  ].join('\n');
}

export function insertMissingCommasBetweenArrayValues(json: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (let i = 0; i < json.length; i += 1) {
    const ch = json[i];
    output += ch;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        if (stack[stack.length - 1] === '[') {
          const inserted = appendMissingArrayComma(json, i);
          if (inserted) {
            output += inserted.whitespace;
            output += ',';
            i = inserted.resumeAt;
          }
        }
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}') {
      if (stack[stack.length - 1] === '{') stack.pop();
      if (stack[stack.length - 1] === '[') {
        const inserted = appendMissingArrayComma(json, i);
        if (inserted) {
          output += inserted.whitespace;
          output += ',';
          i = inserted.resumeAt;
        }
      }
    } else if (ch === ']') {
      if (stack[stack.length - 1] === '[') stack.pop();
      if (stack[stack.length - 1] === '[') {
        const inserted = appendMissingArrayComma(json, i);
        if (inserted) {
          output += inserted.whitespace;
          output += ',';
          i = inserted.resumeAt;
        }
      }
    }
  }

  return output;
}

function appendMissingArrayComma(json: string, valueEndIndex: number): { whitespace: string; resumeAt: number } | null {
  let next = valueEndIndex + 1;
  while (next < json.length && /\s/.test(json[next])) next += 1;
  const nextCh = json[next];
  if (!jsonValueCanStart(nextCh)) return null;
  return {
    whitespace: json.slice(valueEndIndex + 1, next),
    resumeAt: next - 1,
  };
}

function jsonValueCanStart(ch: string | undefined): boolean {
  return ch === '{'
    || ch === '['
    || ch === '"'
    || ch === '-'
    || ch === 't'
    || ch === 'f'
    || ch === 'n'
    || (typeof ch === 'string' && ch >= '0' && ch <= '9');
}

function scanBalancedObject(raw: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

function compactPromptBlock(value: string, limit: number): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, Math.max(0, limit - 3))}...`;
}
