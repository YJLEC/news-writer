import { compareCodePointStrings } from './constants.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const canonicalize = (value: unknown, seen: Set<object>): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON rejects non-finite numbers.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw new TypeError('Value is not canonical JSON data.');
  if (seen.has(value)) throw new TypeError('Canonical JSON rejects cyclic objects.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, seen));
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON accepts only plain objects.');
    }
    const object = value as Record<string, unknown>;
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(object).sort(compareCodePointStrings)) {
      const entry = object[key];
      if (entry === undefined) throw new TypeError('Canonical JSON rejects undefined properties.');
      output[key] = canonicalize(entry, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
};

export const canonicalJson = (value: unknown): string =>
  `${JSON.stringify(canonicalize(value, new Set()))}\n`;

export const canonicalJsonLine = (value: unknown): string =>
  JSON.stringify(canonicalize(value, new Set()));
