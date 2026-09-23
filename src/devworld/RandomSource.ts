export interface RandomSource {
  next(): number;
}

export class SystemRandomSource implements RandomSource {
  next(): number {
    return Math.random();
  }
}

export function nextRandom(
  source: RandomSource,
  minimum: number,
  maximumExclusive: number,
): number {
  const value = source.next();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error("RandomSource.next() must return a value in [0, 1).");
  }
  return minimum + value * (maximumExclusive - minimum);
}
