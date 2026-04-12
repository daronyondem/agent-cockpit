/**
 * Ollama-based embedding service for the Knowledge Base vector layer.
 *
 * Wraps the Ollama `/api/embed` endpoint (available since Ollama ≥ 0.4).
 * Designed to be stateless — callers pass config per call so the service
 * doesn't hold workspace-specific state.
 */

// ── Defaults ────────────────────────────────────────────────────────────────

export const EMBEDDING_DEFAULTS = {
  model: 'nomic-embed-text',
  ollamaHost: 'http://localhost:11434',
  dimensions: 768,
} as const;

// ── Types ───────────────────────────────────────────────────────────────────

export interface EmbeddingConfig {
  model?: string;
  ollamaHost?: string;
  dimensions?: number;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  dimensions: number;
}

/** Resolved config with all defaults applied. */
export interface ResolvedEmbeddingConfig {
  model: string;
  ollamaHost: string;
  dimensions: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function resolveConfig(cfg?: EmbeddingConfig): ResolvedEmbeddingConfig {
  return {
    model: cfg?.model ?? EMBEDDING_DEFAULTS.model,
    ollamaHost: cfg?.ollamaHost ?? EMBEDDING_DEFAULTS.ollamaHost,
    dimensions: cfg?.dimensions ?? EMBEDDING_DEFAULTS.dimensions,
  };
}

// ── Core API ────────────────────────────────────────────────────────────────

/**
 * Embed a single text string via Ollama.
 * Throws on network errors or if the model isn't available.
 */
export async function embedText(
  text: string,
  cfg?: EmbeddingConfig,
): Promise<EmbeddingResult> {
  const resolved = resolveConfig(cfg);
  const url = `${resolved.ollamaHost.replace(/\/+$/, '')}/api/embed`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: resolved.model, input: text }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Ollama embed failed (${res.status}): ${body || res.statusText}`,
    );
  }

  const json = (await res.json()) as { embeddings?: number[][] };
  const vec = json.embeddings?.[0];
  if (!vec || !Array.isArray(vec)) {
    throw new Error('Ollama returned unexpected embedding response shape');
  }

  return { embedding: vec, model: resolved.model, dimensions: vec.length };
}

/**
 * Embed multiple texts in a single Ollama call.
 * Ollama's `/api/embed` accepts `input` as string | string[].
 */
export async function embedBatch(
  texts: string[],
  cfg?: EmbeddingConfig,
): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await embedText(texts[0], cfg)];

  const resolved = resolveConfig(cfg);
  const url = `${resolved.ollamaHost.replace(/\/+$/, '')}/api/embed`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: resolved.model, input: texts }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Ollama embed batch failed (${res.status}): ${body || res.statusText}`,
    );
  }

  const json = (await res.json()) as { embeddings?: number[][] };
  const vecs = json.embeddings;
  if (!Array.isArray(vecs) || vecs.length !== texts.length) {
    throw new Error(
      `Ollama returned ${vecs?.length ?? 0} embeddings for ${texts.length} inputs`,
    );
  }

  return vecs.map((vec) => ({
    embedding: vec,
    model: resolved.model,
    dimensions: vec.length,
  }));
}

/**
 * Quick connectivity + model availability check.
 * Returns true if Ollama is reachable and the model responds.
 */
export async function checkOllamaHealth(
  cfg?: EmbeddingConfig,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await embedText('health check', cfg);
    if (result.embedding.length === 0) {
      return { ok: false, error: 'Empty embedding returned' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
