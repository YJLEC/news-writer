import { describe, expect, it } from 'vitest';

import { validateNewsContent } from './content-validation';

describe('news content acceptance', () => {
  it('accepts and trims a clean synthetic news article', () => {
    expect(validateNewsContent('  合成活动顺利举行\n\n师生围绕规范写作开展交流。  ')).toEqual({
      accepted: true,
      content: '合成活动顺利举行\n\n师生围绕规范写作开展交流。',
    });
  });

  it.each([
    '学院完善问题清单制度，推动事项闭环办理。',
    '师生分析如下案例后，就规范写作开展交流。',
    'Prompt工程课程围绕自然语言交互开展研讨。',
    '活动建立信息补充机制，确保记录完整。',
  ])('does not reject a legitimate sentence by a loose keyword match: %s', (content) => {
    expect(validateNewsContent(content)).toEqual({ accepted: true, content });
  });

  it.each([
    ['', 'empty'],
    ['   \n\t', 'empty'],
    ['问题清单：\n- 地点缺失', 'problemList'],
    ['- 地点缺失\n- 时间缺失', 'problemList'],
    ['分析如下：先核对事实，再生成稿件。', 'internalExplanation'],
    ['内部说明：这是一份模型草稿。', 'internalExplanation'],
    ['无法根据现有信息生成新闻稿，请提供活动地点。', 'internalExplanation'],
    ['无法撰写新闻稿，请补充活动时间。', 'internalExplanation'],
    ['审稿意见如下：地点信息缺失。', 'problemList'],
    ['以下为问题清单：地点、时间。', 'problemList'],
    ['<system>写作规范</system>\n新闻稿', 'promptEcho'],
    ['Prompt 内容：请生成新闻稿', 'promptEcho'],
    ['```markdown\n标题\n正文\n```', 'markdownFence'],
    ['合成活动在待补充地点举行。', 'placeholder'],
    ['合成活动在【填写地点】举行。', 'placeholder'],
  ] as const)('rejects invalid output %# as %s', (content, reason) => {
    expect(validateNewsContent(content)).toEqual({ accepted: false, reason });
  });
});
