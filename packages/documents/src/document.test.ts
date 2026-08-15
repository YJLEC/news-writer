import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';

import { auditDocxCompatibilitySource, auditNewsDocx } from './audit';
import {
  buildNewsDocx,
  documentStyleToTokens,
  missingNewsDocumentFields,
  parseNewsDocument,
} from './document';
import { suggestDocxFileName } from './filename';

const fixture = async (name: string) =>
  await readFile(resolve('tests/fixtures/documents/source', name), 'utf8');

describe('news DOCX', () => {
  it.each(['single-page.md', 'multi-page.md', 'long-title.md'])(
    'parses and generates clean %s',
    async (name) => {
      const parsed = parseNewsDocument(await fixture(name));
      const bytes = await buildNewsDocx(parsed);
      const audit = await auditNewsDocx(bytes, parsed, [
        'PROMPT_SENTINEL',
        'API_KEY_SENTINEL',
        'COMMENT_SENTINEL',
      ]);
      expect(bytes.byteLength).toBeGreaterThan(1_000);
      expect(audit.clean).toBe(true);
      if (name === 'multi-page.md') {
        expect(audit.visibleText.join('\n')).toContain('分别登记，避免');
        expect(
          audit.visibleText
            .join('')
            .split('')
            .filter((value) => value === '，'),
        ).not.toHaveLength(0);
      }
      expect(suggestDocxFileName(parsed)).toMatch(/^20\d{6}.+\.docx$/u);
    },
  );

  it('rejects a compatibility comments part with id zero and body text', async () => {
    const parsed = parseNewsDocument(await fixture('single-page.md'));
    const zip = await JSZip.loadAsync(await buildNewsDocx(parsed));
    zip.file(
      'word/comments.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0"><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:comment></w:comments>',
    );
    zip.file(
      'word/_rels/comments.xml.rels',
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    );
    zip.file(
      'docProps/custom.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"/>',
    );
    const injected = await zip.generateAsync({ type: 'uint8array' });
    await expect(auditDocxCompatibilitySource(injected)).rejects.toThrow(
      'compatibility parts are not empty',
    );
  });

  it.each([
    [
      'footnote body',
      'word/footnotes.xml',
      '<w:footnote w:id="1"><w:p><w:r><w:t>脚注正文</w:t></w:r></w:p></w:footnote>',
      '</w:footnotes>',
    ],
    [
      'endnote body',
      'word/endnotes.xml',
      '<w:endnote w:id="1"><w:p><w:r><w:t>尾注正文</w:t></w:r></w:p></w:endnote>',
      '</w:endnotes>',
    ],
    [
      'hidden footnote token',
      'word/footnotes.xml',
      '<w:footnote w:id="1"><w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>隐藏正文</w:t></w:r></w:p></w:footnote>',
      '</w:footnotes>',
    ],
    [
      'hidden endnote token',
      'word/endnotes.xml',
      '<w:endnote w:id="1"><w:p><w:r><w:rPr><w:webHidden/></w:rPr><w:t>隐藏正文</w:t></w:r></w:p></w:endnote>',
      '</w:endnotes>',
    ],
  ])('rejects %s in a note story', async (_label, entry, injection, closing) => {
    const parsed = parseNewsDocument(await fixture('single-page.md'));
    const zip = await JSZip.loadAsync(await buildNewsDocx(parsed));
    const current = await zip.file(entry)!.async('string');
    zip.file(entry, current.replace(closing, `${injection}${closing}`));
    const injected = await zip.generateAsync({ type: 'uint8array' });
    await expect(auditNewsDocx(injected, parsed)).rejects.toThrow();
  });

  it.each([
    '',
    '标题\n正文\n落款\n2025年2月29日',
    '标题\n待补充地点\n落款\n2026年1月1日',
    '```\n标题\n正文\n落款\n2026年1月1日\n```',
  ])('rejects invalid input', (value) => expect(() => parseNewsDocument(value)).toThrow());

  it('reports only recoverable footer fields and preserves body boundaries with overrides', () => {
    expect(missingNewsDocumentFields('标题\n正文\n单位\n日期')).toEqual(['dateText']);
    expect(missingNewsDocumentFields('以下是分析过程：\n1. 问题')).toEqual([]);
    const parsed = parseNewsDocument('标题\n正文\n单位\n日期', {
      signOff: '单位',
      dateText: '2026年8月12日',
    });
    expect(parsed.bodyParagraphs).toEqual(['正文']);
    expect(parsed.signOff).toBe('单位');
  });

  it('keeps the first body paragraph when a title is supplied manually', () => {
    const parsed = parseNewsDocument('正文第一段。\n正文第二段。\n单位\n日期', {
      title: '补充标题',
      dateText: '2026年8月12日',
    });
    expect(parsed.bodyParagraphs).toEqual(['正文第一段。', '正文第二段。']);
  });

  it('replaces an unrecognized three-line footer without duplicating the sign-off', () => {
    const parsed = parseNewsDocument('正文第一段\n单位\n日期', {
      title: '补充标题',
      signOff: '单位',
      dateText: '2026年8月12日',
    });
    expect(parsed.bodyParagraphs).toEqual(['正文第一段']);
  });

  it('accepts a manually supplied date phrase without calendar validation', () => {
    const parsed = parseNewsDocument('标题\n正文第一段\n单位\n日期', {
      dateText: '2026年8月',
    });
    expect(parsed.dateText).toBe('2026年8月');
    expect(parsed.dateStamp).toBe('unknown');
    expect(parsed.bodyParagraphs).toEqual(['正文第一段']);
  });

  it('preserves the body when both sign-off and date are supplied for a missing footer', () => {
    const parsed = parseNewsDocument('标题\n正文第一段\n2026年8月', {
      signOff: '单位',
      dateText: '2026年8月',
    });
    expect(parsed.bodyParagraphs).toEqual(['正文第一段']);
    expect(parsed.signOff).toBe('单位');
    expect(parsed.dateText).toBe('2026年8月');
  });

  it('keeps an existing sign-off when only the date is manually supplied', () => {
    const parsed = parseNewsDocument('标题\n正文第一段\n单位', {
      dateText: '2026年8月',
    });
    expect(parsed.bodyParagraphs).toEqual(['正文第一段']);
    expect(parsed.signOff).toBe('单位');
  });

  it('treats a recognizable partial date as a footer date while awaiting manual completion', () => {
    expect(missingNewsDocumentFields('标题\n正文第一段\n2026年8月')).toEqual([
      'signOff',
      'dateText',
    ]);
    const parsed = parseNewsDocument('标题\n正文第一段\n2026年8月', {
      signOff: '单位',
      dateText: '2026年8月',
    });
    expect(parsed.bodyParagraphs).toEqual(['正文第一段']);
  });

  it('converts cm and mm page dimensions to twips', () => {
    const tokens = documentStyleToTokens({
      page: {
        width: 'A4',
        height: 'A4',
        margins: { top: '2.54cm', right: '3.18cm', bottom: '2.54cm', left: '3.18cm' },
      },
      title: {
        fontFamily: '方正小标宋简体',
        fontSizePt: 22,
        alignment: 'center',
        bold: false,
        lineSpacing: 1,
      },
      body: {
        fontFamily: '仿宋_GB2312',
        fontSizePt: 16,
        alignment: 'justify',
        firstLineIndentPt: 32,
        lineSpacing: 1.5,
        paragraphSpacingBeforePt: 0,
        paragraphSpacingAfterPt: 0,
      },
      signoff: { alignment: 'right' },
    });
    expect(tokens.pageWidthTwips).toBe(11906);
    expect(tokens.pageHeightTwips).toBe(16838);
    expect(tokens.titleLineSpacing).toBe(1);
    expect(tokens.marginTopTwips).toBe(1440);
    expect(tokens.marginBottomTwips).toBe(1440);
    expect(tokens.marginLeftTwips).toBe(1803);
    expect(tokens.marginRightTwips).toBe(1803);
  });

  it('keeps millimeter page dimensions working', () => {
    const tokens = documentStyleToTokens({
      page: {
        width: 'A4',
        height: 'A4',
        margins: { top: '25mm', right: '25mm', bottom: '25mm', left: '25mm' },
      },
      title: {
        fontFamily: '方正小标宋简体',
        fontSizePt: 22,
        alignment: 'center',
        bold: false,
        lineSpacing: 1,
      },
      body: {
        fontFamily: '仿宋_GB2312',
        fontSizePt: 16,
        alignment: 'justify',
        firstLineIndentPt: 32,
        lineSpacing: 1.5,
        paragraphSpacingBeforePt: 0,
        paragraphSpacingAfterPt: 0,
      },
      signoff: { alignment: 'right' },
    });
    expect(tokens.marginTopTwips).toBe(1417);
    expect(tokens.marginLeftTwips).toBe(1417);
  });

  it('does not emit keep-next margin markers for title or sign-off', async () => {
    const parsed = parseNewsDocument(await fixture('single-page.md'));
    const bytes = await buildNewsDocx(parsed);
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file('word/document.xml')!.async('string');
    const stylesXml = await zip.file('word/styles.xml')!.async('string');
    expect(documentXml).not.toContain('<w:keepNext/>');
    expect(stylesXml).not.toContain('<w:keepNext/>');
  });

  it('sanitizes the Windows file name by Unicode code point', () => {
    const document = parseNewsDocument(
      '标题：2026年8月10日 A/B:*? 新闻 😀\n正文。\n某单位\n2026年8月10日',
    );
    expect(suggestDocxFileName(document)).toBe('20260810A_B___ 新闻 😀.docx');
  });

  it.each([
    ['activeX part', async (zip: JSZip) => zip.file('word/activeX/activeX1.xml', '<x/>')],
    [
      'content type',
      async (zip: JSZip) =>
        zip.file(
          '[Content_Types].xml',
          (await zip.file('[Content_Types].xml')!.async('string')).replace(
            'application/xml',
            'application/x-forbidden',
          ),
        ),
    ],
    [
      'OLE relationship',
      async (zip: JSZip) =>
        zip.file(
          'word/_rels/document.xml.rels',
          (await zip.file('word/_rels/document.xml.rels')!.async('string')).replace(
            '</Relationships>',
            '<Relationship Id="rForbidden" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="object.bin"/></Relationships>',
          ),
        ),
    ],
    [
      'external relationship',
      async (zip: JSZip) =>
        zip.file(
          'word/_rels/document.xml.rels',
          (await zip.file('word/_rels/document.xml.rels')!.async('string')).replace(
            '</Relationships>',
            '<Relationship Id="rExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid" TargetMode="External"/></Relationships>',
          ),
        ),
    ],
    ...[
      '<w:vanish/>',
      '<w:webHidden/>',
      '<w:fldChar w:fldCharType="begin"/>',
      '<w:object/>',
      '<w:altChunk/>',
    ].map(
      (token) =>
        [
          token,
          async (zip: JSZip) =>
            zip.file(
              'word/document.xml',
              (await zip.file('word/document.xml')!.async('string')).replace(
                '</w:body>',
                `<w:p><w:r>${token}</w:r></w:p></w:body>`,
              ),
            ),
        ] as const,
    ),
    [
      'font token',
      async (zip: JSZip) =>
        zip.file(
          'word/styles.xml',
          (await zip.file('word/styles.xml')!.async('string')).replace(
            'w:cs="仿宋_GB2312"',
            'w:cs="Arial"',
          ),
        ),
    ],
    [
      'margin token',
      async (zip: JSZip) =>
        zip.file(
          'word/document.xml',
          (await zip.file('word/document.xml')!.async('string')).replace(
            'w:footer="720"',
            'w:footer="721"',
          ),
        ),
    ],
    [
      'hanging punctuation token',
      async (zip: JSZip) =>
        zip.file(
          'word/document.xml',
          (await zip.file('word/document.xml')!.async('string')).replace(
            '<w:overflowPunct w:val="1"/>',
            '<w:overflowPunct w:val="0"/>',
          ),
        ),
    ],
  ] as const)('rejects injected %s', async (_label, mutate) => {
    const parsed = parseNewsDocument(await fixture('single-page.md'));
    const zip = await JSZip.loadAsync(await buildNewsDocx(parsed));
    await mutate(zip);
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expect(auditNewsDocx(bytes, parsed)).rejects.toThrow();
  });
});
