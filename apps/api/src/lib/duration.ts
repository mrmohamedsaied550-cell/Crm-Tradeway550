/**
 * Convert short duration strings ("15m", "7d", "1h", "30s") into milliseconds.
 */
export function parseDuration(input: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d|w)$/i.exec(input.trim());
  if (!match) throw new Error(`Invalid duration: ${input}`);
  const n = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const map: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return n * map[unit]!;
}
