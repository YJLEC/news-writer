export const NORMALIZER_VERSION = 'retrieval-normalizer-nfkc-html-v1' as const;
export const TOKENIZER_VERSION = 'han-1-2-3gram-ascii-v1' as const;
export const RETRIEVAL_ENGINE_VERSION = 'bm25-han-ngram-v1' as const;

export const BM25_PARAMETERS = {
  k1: 1.5,
  b: 0.75,
  queryTfCap: 3,
  defaultTopK: 5,
  maximumTopK: 20,
  reportScoreDecimals: 6,
} as const;

export const KNOWLEDGE_FILE_NAMES = [
  'corpus.jsonl',
  'index.json',
  'training_rules.txt',
  'metadata.json',
] as const;

export const MAX_PROMPT_EXCERPT_CODE_POINTS = 1_000;

export const compareCodePointStrings = (left: string, right: string): number => {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
};
