/** Compare a release's >= engine floor without dropping minor/patch levels. */
export function nodeRuntimeMeetsRequirement(
  version: string | null,
  minimumMajor = 22,
  engine: string | null = '>=22.12.0',
): boolean {
  const actual = version?.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!actual) return false;
  const floor = engine?.match(/^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  const required = floor && Number(floor[1]) >= minimumMajor
    ? [Number(floor[1]), Number(floor[2] || 0), Number(floor[3] || 0)]
    : [minimumMajor, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    const part = Number(actual[i + 1]);
    if (part !== required[i]) return part > required[i];
  }
  return true;
}
