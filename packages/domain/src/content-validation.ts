export type NewsContentRejection =
  'empty' | 'problemList' | 'internalExplanation' | 'promptEcho' | 'markdownFence' | 'placeholder';

export type NewsContentValidation =
  { accepted: true; content: string } | { accepted: false; reason: NewsContentRejection };

const forbiddenSection =
  /^(?:#{1,6}\s*)?(?:(?:以下(?:为|是)\s*)?(?:问题清单|需补充信息|待补充信息|审稿意见|修改说明)(?:如下)?)(?:\s*[：:]|\s*$)/imu;
const internalSection = /^(?:#{1,6}\s*)?(?:分析过程|思考过程|内部说明)(?:\s*[：:]|\s*$)/imu;
const placeholder =
  /(?:待补充|需补充|有待补充|tbd|todo|\[(?:填写|补充)[^\]]*\]|【(?:填写|补充)[^】]*】|（(?:填写|补充)[^）]*）)/iu;
const promptEcho =
  /(?:<\/?(?:system|user|assistant|prompt|instructions?|context)(?:\s[^>]*)?>|^(?:#{1,6}\s*)?prompt\s*(?:内容|回显)?\s*[：:])/imu;
const markdownFence = /```|~~~/u;
const internalWrapper =
  /^(?:以下是(?:根据[^\n]{0,80})?(?:生成|修改|审校)的|作为(?:一个)?AI|我(?:将|会|需要)先|分析如下|说明如下)/iu;
const refusalWrapper =
  /^无法(?:根据[^\n。！？]{0,80})?(?:生成|撰写)(?:一篇|本篇|这篇)?新闻稿(?:\s*[，,：:]|\s*$)/iu;
const listLine = /^\s*(?:[-*+]\s+|\d+[.)、]\s*)/u;

export const validateNewsContent = (input: string): NewsContentValidation => {
  const content = input.trim();
  if (content.length === 0) return { accepted: false, reason: 'empty' };
  if (markdownFence.test(content)) return { accepted: false, reason: 'markdownFence' };
  if (promptEcho.test(content)) return { accepted: false, reason: 'promptEcho' };
  if (placeholder.test(content)) return { accepted: false, reason: 'placeholder' };
  if (
    internalSection.test(content) ||
    internalWrapper.test(content) ||
    refusalWrapper.test(content)
  ) {
    return { accepted: false, reason: 'internalExplanation' };
  }
  const lines = content.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (forbiddenSection.test(content) || lines.every((line) => listLine.test(line))) {
    return { accepted: false, reason: 'problemList' };
  }
  return { accepted: true, content };
};
