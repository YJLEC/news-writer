const secretPatterns = [
  /\b(?:sk|dk)-[a-z0-9_-]{12,}\b/iu,
  /\bbearer\s+[a-z0-9._~+/=-]{12,}\b/iu,
  /["'](?:apiKey|authorization|headers)["']\s*:/iu,
] as const;

export const containsSecretMaterial = (
  values: readonly string[],
  exactSecrets: readonly string[] = [],
): boolean => {
  const usableSecrets = exactSecrets.filter((secret) => secret.length > 0);
  return values.some(
    (value) =>
      usableSecrets.some((secret) => value.includes(secret)) ||
      secretPatterns.some((pattern) => pattern.test(value)),
  );
};
