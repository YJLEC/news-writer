import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  commentIdSchema,
  retrievalReportIdSchema,
  sha256Schema,
  timestampSchema,
  type Sha256,
} from '@news-writer/shared';

import { DEFAULT_GENERATION_CONFIG } from './config.js';
import {
  checkMissingFacts,
  fingerprintCommentSnapshot,
  preparePrompt,
  resolveFactOverrides,
  type PromptPreparationInput,
} from './prompt-preparation.js';

const root = path.resolve(import.meta.dirname, '../../..');
const read = async (relativePath: string) =>
  (await readFile(path.join(root, relativePath), 'utf8')).replace(/\r\n?/g, '\n');
const sha256Utf8 = (text: string): Sha256 =>
  sha256Schema.parse(createHash('sha256').update(text, 'utf8').digest('hex'));

const revisionId = () => randomUUID() as never;
const versionId = () => randomUUID() as never;

const common = (minutes: string, profile: 'official' | 'other', publisher: string) => ({
  schemaVersion: 1 as const,
  profile,
  publisher,
  minutes: { revisionId: revisionId(), contentSha256: sha256Utf8(minutes), content: minutes },
  config: { defaults: DEFAULT_GENERATION_CONFIG },
  writingRulesVersion: 'prompt-contract-v1' as const,
});

describe('Prompt preparation', () => {
  it('allows user fact overrides without changing the minutes snapshot', () => {
    const facts = checkMissingFacts({
      minutes: '活动日期：2099年1月1日\n举办单位：自动识别单位\n',
      factOverrides: {
        date: { mode: 'manual', value: '2026年8月' },
        location: { mode: 'manual', value: '线上会议室' },
        organizer: { mode: 'none' },
      },
    });
    expect(facts.date).toEqual({ status: 'present', evidence: '2026年8月', source: 'user' });
    expect(facts.location).toEqual({ status: 'present', evidence: '线上会议室', source: 'user' });
    expect(facts.organizer).toEqual({ status: 'missing', source: 'user' });
    expect(facts.time).toEqual({ status: 'missing', source: 'detected' });
    expect(facts.blocking).toBe(true);
  });

  it('includes fact override decisions in the prompt text and fingerprint', () => {
    const minutes = '活动日期：2099年1月1日\n举办单位：测试单位\n';
    const base: PromptPreparationInput = {
      ...common(minutes, 'official', '测试单位'),
      kind: 'draftGeneration' as const,
      parent: null,
      comments: [],
      retrieval: { state: 'unavailable' as const },
    };
    const automatic = preparePrompt(base, { sha256Utf8 });
    const overridden = preparePrompt(
      { ...base, factOverrides: { location: { mode: 'manual' as const, value: '线上会议室' } } },
      { sha256Utf8 },
    );
    expect(overridden.messages[0]?.content).toContain('# 事实检查提示');
    expect(overridden.messages[0]?.content).toContain('线上会议室（用户确认）');
    expect(overridden.messages[0]?.content).not.toContain('# 用户事实检查确认');
    expect(overridden.messages[0]?.content).toContain('线上会议室');
    expect(overridden.inputFingerprint).not.toBe(automatic.inputFingerprint);
  });

  it('inherits fact overrides while allowing an explicit auto reset', () => {
    expect(
      resolveFactOverrides(
        { date: { mode: 'manual', value: '2026年8月' }, location: { mode: 'none' } },
        { date: { mode: 'auto' } },
      ),
    ).toEqual({ date: { mode: 'auto' }, location: { mode: 'none' } });
  });

  it('treats a manually confirmed missing date as an omitted footer, not placeholder text', () => {
    const prepared = preparePrompt(
      {
        ...common('举办单位：测试单位\n', 'official', '测试单位'),
        kind: 'draftGeneration',
        parent: null,
        comments: [],
        retrieval: { state: 'unavailable' },
        factOverrides: { date: { mode: 'none' } },
      },
      { sha256Utf8 },
    );
    expect(prepared.messages[0]?.content).toContain('省略日期落款');
    expect(prepared.messages[0]?.content).not.toContain('日期“日期未提供”');
  });

  it('includes an immutable institution snapshot as additive guidance', async () => {
    const minutes = await read('tests/fixtures/minutes/gf-01-official-complete.md');
    const prepared = preparePrompt(
      {
        ...common(minutes, 'official', 'Synthetic Publisher'),
        kind: 'draftGeneration',
        parent: null,
        comments: [],
        retrieval: {
          state: 'zeroHits',
          reportId: retrievalReportIdSchema.parse(randomUUID()),
          knowledgeVersion: 'kw_0000000000000000_0000000000000000',
          retrievalEngineVersion: 'bm25-v1',
          hits: [],
        },
        profileSnapshot: {
          profileId: 'profile_synthetic-public',
          profileVersion: 'public-fixture-v1',
          writingRulesVersion: 'writing-v1',
          promptContractVersion: 'prompt-v1',
          documentStyleVersion: 'style-v1',
          knowledgeVersion: 'kw_0000000000000000_0000000000000000',
          resourceHash: sha256Utf8('synthetic-profile'),
          rules: ['Prefer concise factual leads.'],
          promptSections: {
            initialDraft: 'Use the profile title convention.',
            secondReview: 'Review facts.',
            commentRevision: 'Apply comments.',
          },
        },
      },
      { sha256Utf8 },
    );
    expect(prepared.messages[0]?.content).toContain('profile_synthetic-public');
    expect(prepared.messages[0]?.content).toContain('Prefer concise factual leads.');
    expect(prepared.messages[0]?.content).toContain('不能关闭系统事实边界');
  });

  it('matches the official generation golden byte for byte', async () => {
    const minutes = await read('tests/fixtures/minutes/gf-01-official-complete.md');
    const input: PromptPreparationInput = {
      ...common(minutes, 'official', '示例学院'),
      kind: 'draftGeneration',
      parent: null,
      comments: [],
      retrieval: {
        state: 'used',
        reportId: retrievalReportIdSchema.parse(randomUUID()),
        knowledgeVersion: 'golden-v1',
        retrievalEngineVersion: 'bm25-v1',
        hits: [
          {
            rank: 1,
            referenceLabel: 'r01',
            title: '示例学院开展资料来源核验练习',
            promptExcerpt:
              '2098年3月8日，示例学院组织学生开展资料来源核验练习。学生围绕发布日期、作者身份和数据出处制作检查表，并使用两份公开材料进行交叉比对。',
          },
        ],
      },
      config: { defaults: DEFAULT_GENERATION_CONFIG, task: { maxWords: 800 } },
    };
    expect(preparePrompt(input, { sha256Utf8 }).messages[0]?.content).toBe(
      await read('tests/golden/prompts/gf-01-generation.txt'),
    );
  });

  it('matches the other-profile generation golden byte for byte', async () => {
    const minutes = await read('tests/fixtures/minutes/gf-04-other-channel-material-priority.md');
    const input: PromptPreparationInput = {
      ...common(minutes, 'other', '青禾科普实践队'),
      kind: 'draftGeneration',
      parent: null,
      comments: [],
      retrieval: {
        state: 'used',
        reportId: retrievalReportIdSchema.parse(randomUUID()),
        knowledgeVersion: 'golden-v1',
        retrievalEngineVersion: 'bm25-v1',
        hits: [
          {
            rank: 1,
            referenceLabel: 'r03',
            title: '青禾科普实践队开展家庭用电观察活动',
            promptExcerpt:
              '2098年5月20日，青禾科普实践队在社区活动室组织家庭用电观察。队员设计照明、待机和集中使用三种情境，参与家庭分别记录电量变化。',
          },
        ],
      },
      config: {
        defaults: DEFAULT_GENERATION_CONFIG,
        task: { targetChannel: '实践队公众号', maxWords: 900 },
      },
    };
    expect(preparePrompt(input, { sha256Utf8 }).messages[0]?.content).toBe(
      await read('tests/golden/prompts/gf-04-other-generation.txt'),
    );
  });

  it('matches the review golden byte for byte', async () => {
    const minutes = await read('tests/fixtures/minutes/gf-03-official-missing-location.md');
    const draft =
      '示例学院举办校园公共表达训练交流会\n\n2099年6月9日，示例学院举办校园公共表达训练交流会。学院学生代表参加活动，现场共有三百余人。\n\n活动中，指导教师说明发言结构和限时要求，学生完成两分钟陈述，并根据互评意见修改表达方式。\n\n本次活动有效提升了学生的表达能力，为学生今后的全面发展奠定了坚实基础。\n\n示例学院\n2099年6月9日\n';
    const input: PromptPreparationInput = {
      ...common(minutes, 'official', '示例学院'),
      kind: 'aiReview',
      parent: { versionId: versionId(), contentSha256: sha256Utf8(draft), content: draft },
      newSupplementalFacts: '活动地点：图书馆研讨室 C203。',
      comments: [],
      config: { defaults: DEFAULT_GENERATION_CONFIG, task: { maxWords: 800 } },
    };
    expect(preparePrompt(input, { sha256Utf8 }).messages[0]?.content).toBe(
      await read('tests/golden/prompts/gf-03-review-with-supplement.txt'),
    );
  });

  it('matches the comment revision golden byte for byte', async () => {
    const minutes = await read('tests/fixtures/minutes/gf-04-other-channel-material-priority.md');
    const draft =
      '青禾科普实践队开展家庭节水观察活动\n\n2099年7月21日，青禾科普实践队在社区共享教室开展家庭节水观察活动。实践队响应社区科普倡议，通过三个用水情境引导参与家庭记录用量、比较差异，并共同整理节水建议。\n\n“每一滴水都有远方。”活动现场，队员围绕不同情境进行了细致讲解，参与者认真记录各项变化，交流如何在日常生活中减少不必要的用水。\n\n活动结束前，参与者用卡片写下准备在一周内尝试的改变。本次活动让节水理念更加深入人心，也展现了实践队服务社区的责任担当。\n\n青禾科普实践队\n2099年7月21日\n';
    const comments = [
      [
        '实践队响应社区科普倡议',
        '背景倡议不是实践队的实际行动依据，请删除“响应”关系，只保留纪要确认的活动事实。',
      ],
      [
        '“每一滴水都有远方。”',
        '这句话来自视频创意，不是现场发言，请删除，不要改写成其他现场引语。',
      ],
      [
        '让节水理念更加深入人心，也展现了实践队服务社区的责任担当',
        '结尾评价超出纪要，请改为参与者形成一周节水尝试计划这一可核验结果。',
      ],
    ].map(([quote, body], index) => {
      const start = draft.indexOf(quote!);
      return {
        id: commentIdSchema.parse(`00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`),
        createdAt: timestampSchema.parse(`2026-08-09T00:00:0${index}.000Z`),
        anchor: {
          kind: 'textQuote' as const,
          contentSha256: sha256Utf8(draft),
          start,
          end: start + quote!.length,
          exact: quote!,
          prefix: draft.slice(Math.max(0, start - 32), start),
          suffix: draft.slice(start + quote!.length, start + quote!.length + 32),
        },
        quotedText: quote!,
        body: body!,
      };
    });
    const input: PromptPreparationInput = {
      ...common(minutes, 'other', '青禾科普实践队'),
      kind: 'commentRevision',
      parent: { versionId: versionId(), contentSha256: sha256Utf8(draft), content: draft },
      comments,
      config: {
        defaults: DEFAULT_GENERATION_CONFIG,
        task: { targetChannel: '实践队公众号', maxWords: 700 },
      },
    };
    expect(preparePrompt(input, { sha256Utf8 }).messages[0]?.content).toBe(
      await read('tests/golden/prompts/gf-09-revision-with-comments.txt'),
    );
  });

  it('keeps fact checking independent of unavailable retrieval and escapes materials', () => {
    const minutes = '活动日期：2099年1月1日\n活动地点：A&B <C>\n举办单位：测试单位\n';
    const prepared = preparePrompt(
      {
        ...common(minutes, 'official', '测试单位'),
        kind: 'draftGeneration',
        parent: null,
        comments: [],
        retrieval: { state: 'unavailable' },
      },
      { sha256Utf8 },
    );
    expect(prepared.factCheck.blocking).toBe(false);
    expect(prepared.trace.retrieval).toEqual({ state: 'unavailable' });
    expect(prepared.messages[0]?.content).toContain('A&amp;B &lt;C&gt;');
  });

  it('returns a blocking risk for conflicting supplemental facts', () => {
    const minutes = '活动日期：2099年1月1日\n活动地点：A101\n举办单位：测试单位\n';
    const draft = '标题\n\n正文\n';
    const prepared = preparePrompt(
      {
        ...common(minutes, 'official', '测试单位'),
        kind: 'aiReview',
        parent: { versionId: versionId(), contentSha256: sha256Utf8(draft), content: draft },
        newSupplementalFacts: '活动地点：B202',
        comments: [],
      },
      { sha256Utf8 },
    );
    expect(prepared.risks.map((risk) => risk.code)).toContain('SUPPLEMENT_CONFLICT');
  });

  it.each([
    ['official', '活动纪要和父版本事实来源链中的已确认补充信息', false],
    ['other', '活动纪要中的[活动内容]和父版本事实来源链中的已确认补充信息', true],
  ] as const)(
    'renders a consistent %s revision boundary with inherited facts',
    (profile, expected, expectsSections) => {
      const minutes =
        profile === 'official'
          ? '活动日期：2099年1月1日\n活动地点：A101\n举办单位：测试学院\n'
          : '[主体]\n测试实践队\n\n[活动内容]\n2099年1月1日，测试实践队在A101开展活动。\n';
      const draft = '标题\n\n第一段正文。\n';
      const quote = '第一段';
      const start = draft.indexOf(quote);
      const prepared = preparePrompt(
        {
          ...common(minutes, profile, profile === 'official' ? '测试学院' : '测试实践队'),
          kind: 'commentRevision',
          parent: { versionId: versionId(), contentSha256: sha256Utf8(draft), content: draft },
          branchSupplementalFacts: '活动时间：09:00',
          comments: [
            {
              id: commentIdSchema.parse('00000000-0000-4000-8000-000000000091'),
              createdAt: timestampSchema.parse('2026-08-09T00:00:00.000Z'),
              anchor: {
                kind: 'textQuote',
                contentSha256: sha256Utf8(draft),
                start,
                end: start + quote.length,
                exact: quote,
                prefix: '',
                suffix: '',
              },
              quotedText: quote,
              body: '修改',
            },
          ],
        },
        { sha256Utf8 },
      );
      const content = prepared.messages[0].content;
      expect(content).toContain(expected);
      expect(content).toContain('活动时间：09:00');
      expect(content).not.toContain('本次没有补充信息');
      expect(content.includes('[活动背景]')).toBe(expectsSections);
    },
  );

  it('keeps the no-supplement revision statement aligned with its material block', () => {
    const minutes = '[主体]\n测试实践队\n\n[活动内容]\n2099年1月1日，测试实践队在A101开展活动。\n';
    const draft = '标题\n\n正文。\n';
    const prepared = preparePrompt(
      {
        ...common(minutes, 'other', '测试实践队'),
        kind: 'commentRevision',
        parent: { versionId: versionId(), contentSha256: sha256Utf8(draft), content: draft },
        comments: [
          {
            id: commentIdSchema.parse('00000000-0000-4000-8000-000000000092'),
            createdAt: timestampSchema.parse('2026-08-09T00:00:00.000Z'),
            anchor: {
              kind: 'textQuote',
              contentSha256: sha256Utf8(draft),
              start: 4,
              end: 6,
              exact: '正文',
              prefix: '',
              suffix: '',
            },
            quotedText: '正文',
            body: '修改',
          },
        ],
      },
      { sha256Utf8 },
    );
    expect(prepared.messages[0].content).toContain('本次无补充信息。');
    expect(prepared.messages[0].content).toContain('本次没有补充信息。');
  });

  it.each(['draftGeneration', 'aiReview'] as const)(
    'escapes fact evidence exactly once for %s',
    (kind) => {
      const minutes = '活动日期：2099年1月1日\n活动地点：A&B <inject>\n举办单位：测试单位\n';
      const draft = '标题\n\n正文。\n';
      const prepared = preparePrompt(
        kind === 'draftGeneration'
          ? {
              ...common(minutes, 'official', '测试单位'),
              kind,
              parent: null,
              comments: [],
              retrieval: { state: 'unavailable' },
            }
          : {
              ...common(minutes, 'official', '测试单位'),
              kind,
              parent: {
                versionId: versionId(),
                contentSha256: sha256Utf8(draft),
                content: draft,
              },
              comments: [],
            },
        { sha256Utf8 },
      );
      const content = prepared.messages[0].content;
      expect(content).not.toContain('A&B <inject>');
      expect(content).toContain('A&amp;B &lt;inject&gt;');
      expect(content).not.toContain('A&amp;amp;B');
    },
  );

  it('orders comments by anchor then creation and hashes the same ordered snapshot', () => {
    const minutes = '活动日期：2099年1月1日\n活动地点：A101\n举办单位：测试单位\n';
    const draft = '标题\n\n前文批注位置。后文批注位置。\n';
    const makeComment = (id: string, quote: string, createdAt: string) => {
      const start = draft.indexOf(quote);
      return {
        id: commentIdSchema.parse(id),
        createdAt: timestampSchema.parse(createdAt),
        anchor: {
          kind: 'textQuote' as const,
          contentSha256: sha256Utf8(draft),
          start,
          end: start + quote.length,
          exact: quote,
          prefix: '',
          suffix: '',
        },
        quotedText: quote,
        body: `修改${quote}`,
      };
    };
    const laterCreatedFront = makeComment(
      '00000000-0000-4000-8000-000000000099',
      '前文',
      '2026-08-09T00:00:02.000Z',
    );
    const earlierCreatedBack = makeComment(
      '00000000-0000-4000-8000-000000000098',
      '后文',
      '2026-08-09T00:00:01.000Z',
    );
    const sameAnchorLowerId = {
      ...laterCreatedFront,
      id: commentIdSchema.parse('00000000-0000-4000-8000-000000000097'),
      body: '同锚点稳定顺序',
    };
    const comments = [earlierCreatedBack, laterCreatedFront, sameAnchorLowerId];
    const prepared = preparePrompt(
      {
        ...common(minutes, 'official', '测试单位'),
        kind: 'commentRevision',
        parent: { versionId: versionId(), contentSha256: sha256Utf8(draft), content: draft },
        comments,
      },
      { sha256Utf8 },
    );
    const content = prepared.messages[0].content;
    expect(content.indexOf('同锚点稳定顺序')).toBeLessThan(content.indexOf('修改前文'));
    expect(content.indexOf('修改前文')).toBeLessThan(content.indexOf('修改后文'));
    expect(prepared.trace.comments.sha256).toBe(
      fingerprintCommentSnapshot(comments, { sha256Utf8 }),
    );
  });
});
