import { normalizeRetrievalTextV1 } from './normalization.js';

export type RedactionCategory =
  'apiKey' | 'email' | 'identityNumber' | 'phone' | 'studentNumber' | 'wechat';

export interface RedactionResultV1 {
  redactedText: string;
  counts: Record<RedactionCategory, number>;
}

const RULES: readonly {
  category: RedactionCategory;
  pattern: RegExp;
  replacement: string;
}[] = [
  {
    category: 'email',
    pattern: /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/giu,
    replacement: '[已脱敏邮箱]',
  },
  {
    category: 'apiKey',
    pattern: /\b(?:bearer\s+)?(?:sk-[a-z0-9_-]{16,}|[a-z0-9_-]{32,})\b/giu,
    replacement: '[已脱敏凭据]',
  },
  {
    category: 'identityNumber',
    pattern: /(?<!\d)\d{17}[0-9Xx](?!\d)/gu,
    replacement: '[已脱敏证件号]',
  },
  {
    category: 'phone',
    pattern: /(?<!\d)(?:1[3-9]\d{9}|1[3-9]\d[-\s]\d{4}[-\s]\d{4}|0\d{2,3}-\d{7,8})(?!\d)/gu,
    replacement: '[已脱敏手机号]',
  },
  {
    category: 'studentNumber',
    pattern: /学号\s*[:：]?\s*\d{10,12}(?!\d)/gu,
    replacement: '[已脱敏学号]',
  },
  {
    category: 'wechat',
    pattern: /(?:微信(?:号|ID)?|wechat)\s*[:：]?\s*[a-z][-_a-z0-9]{5,19}/giu,
    replacement: '[已脱敏微信号]',
  },
];

export const redactKnowledgeCandidateV1 = (text: string): RedactionResultV1 => {
  const counts: Record<RedactionCategory, number> = {
    apiKey: 0,
    email: 0,
    identityNumber: 0,
    phone: 0,
    studentNumber: 0,
    wechat: 0,
  };
  let redactedText = normalizeRetrievalTextV1(text);
  for (const rule of RULES) {
    redactedText = redactedText.replace(rule.pattern, () => {
      counts[rule.category] += 1;
      return rule.replacement;
    });
  }
  return { redactedText: normalizeRetrievalTextV1(redactedText), counts };
};

export const findForbiddenKnowledgeTextPatternsV1 = (text: string): readonly string[] => {
  const findings = new Set<string>();
  if (/(?:[A-Za-z]:[\\/]|\\\\|file:\/\/)/u.test(text)) findings.add('absolutePath');
  if (/\u0000|\uFFFD/u.test(text)) findings.add('invalidCharacter');
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) findings.add(rule.category);
    rule.pattern.lastIndex = 0;
  }
  return [...findings].sort();
};
