// Plain Levenshtein-distance similarity — deliberately dependency-free
// rather than pulling in a fuzzy-matching library, since this only ever
// compares short question-length strings (a handful of comparisons per
// form section, not a search-index workload).
function levenshteinDistance(a: string, b: string): number {
  const bLen = b.length;
  let previousRow: number[] = Array.from({ length: bLen + 1 }, (_, j) => j);

  for (let i = 1; i <= a.length; i += 1) {
    const currentRow: number[] = [i];
    for (let j = 1; j <= bLen; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const insertion = (currentRow[j - 1] ?? 0) + 1;
      const deletion = (previousRow[j] ?? 0) + 1;
      const substitution = (previousRow[j - 1] ?? 0) + cost;
      currentRow.push(Math.min(insertion, deletion, substitution));
    }
    previousRow = currentRow;
  }

  return previousRow[bLen] ?? 0;
}

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[*?!.,:;]+$/g, "");
}

// Returns a 0..1 similarity score (1 = identical after normalization).
export function textSimilarity(a: string, b: string): number {
  const normalizedA = normalize(a);
  const normalizedB = normalize(b);

  if (normalizedA.length === 0 || normalizedB.length === 0) {
    return 0;
  }
  if (normalizedA === normalizedB) {
    return 1;
  }

  const distance = levenshteinDistance(normalizedA, normalizedB);
  const maxLength = Math.max(normalizedA.length, normalizedB.length);
  return 1 - distance / maxLength;
}
