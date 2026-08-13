const isAsciiAlphaNumeric = (codePoint: number): boolean =>
  (codePoint >= 0x30 && codePoint <= 0x39) ||
  (codePoint >= 0x41 && codePoint <= 0x5a) ||
  (codePoint >= 0x61 && codePoint <= 0x7a);

const isHanCodePoint = (codePoint: number): boolean =>
  (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
  (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
  (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
  (codePoint >= 0x20000 && codePoint <= 0x2ebef) ||
  (codePoint >= 0x30000 && codePoint <= 0x323af);

const appendHanNgrams = (sequence: readonly string[], output: string[]): void => {
  for (const size of [1, 2, 3] as const) {
    for (let index = 0; index + size <= sequence.length; index += 1) {
      output.push(sequence.slice(index, index + size).join(''));
    }
  }
};

export const tokenizeRetrievalTextV1 = (normalizedText: string): string[] => {
  const output: string[] = [];
  let ascii = '';
  let han: string[] = [];

  const flushAscii = (): void => {
    if (ascii.length > 0) output.push(ascii.toLowerCase());
    ascii = '';
  };
  const flushHan = (): void => {
    appendHanNgrams(han, output);
    han = [];
  };

  for (const character of normalizedText) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isAsciiAlphaNumeric(codePoint)) {
      flushHan();
      ascii += character;
    } else if (isHanCodePoint(codePoint)) {
      flushAscii();
      han.push(character);
    } else {
      flushAscii();
      flushHan();
    }
  }
  flushAscii();
  flushHan();
  return output;
};
