import {
  AlignmentType,
  Document,
  LineRuleType,
  Packer,
  Paragraph,
  PageOrientation,
  TextRun,
} from 'docx';
import JSZip from 'jszip';

import { validateNewsContent } from '@news-writer/domain';

import {
  DOCUMENT_MAX_INPUT_BYTES,
  DOCUMENT_MAX_OUTPUT_BYTES,
  DocumentError,
  newsDocumentSchema,
  type NewsDocument,
  type DocumentStyleTokens,
} from './contracts.js';
import { auditDocxCompatibilitySource, auditNewsDocx } from './audit.js';

const titleFont = '方正小标宋简体';
const bodyFont = '仿宋_GB2312';

export type NewsDocumentStyleTokens = DocumentStyleTokens;

const defaultStyleTokens: NewsDocumentStyleTokens = {
  pageWidthTwips: 11906,
  pageHeightTwips: 16838,
  marginTopTwips: 1440,
  marginRightTwips: 1800,
  marginBottomTwips: 1440,
  marginLeftTwips: 1800,
  titleFontFamily: titleFont,
  bodyFontFamily: bodyFont,
  titleFontSizePt: 22,
  bodyFontSizePt: 16,
  titleBold: false,
  titleAlignment: 'center',
  bodyAlignment: 'justify',
  firstLineIndentPt: 32,
  lineSpacing: 1.5,
  paragraphSpacingBeforePt: 0,
  paragraphSpacingAfterPt: 0,
  signoffAlignment: 'right',
};

export const documentStyleToTokens = (style: {
  page: {
    width: string;
    height: string;
    margins: { top: string; right: string; bottom: string; left: string };
  };
  title: {
    fontFamily: string;
    fontSizePt: number;
    alignment: 'left' | 'center' | 'right';
    bold: boolean;
    lineSpacing: number;
  };
  body: {
    fontFamily: string;
    fontSizePt: number;
    alignment: 'left' | 'center' | 'right' | 'justify';
    firstLineIndentPt: number;
    lineSpacing: number;
    paragraphSpacingBeforePt: number;
    paragraphSpacingAfterPt: number;
  };
  signoff: { alignment: 'left' | 'center' | 'right' };
}): NewsDocumentStyleTokens => {
  const pageTwips = (value: string, kind: 'width' | 'height' | 'margin'): number => {
    const normalized = value.trim().toUpperCase();
    if ((kind === 'width' || kind === 'height') && normalized === 'A4')
      return kind === 'width' ? 11906 : 16838;
    const match = /^(\d+(?:\.\d+)?)(MM|CM)$/u.exec(normalized);
    if (match === null) throw new Error(`Unsupported document dimension: ${value}`);
    const millimeters = match[2] === 'CM' ? Number(match[1]) * 10 : Number(match[1]);
    return Math.round((millimeters / 25.4) * 1440);
  };
  return {
    pageWidthTwips: pageTwips(style.page.width, 'width'),
    pageHeightTwips: pageTwips(style.page.height, 'height'),
    marginTopTwips: pageTwips(style.page.margins.top, 'margin'),
    marginRightTwips: pageTwips(style.page.margins.right, 'margin'),
    marginBottomTwips: pageTwips(style.page.margins.bottom, 'margin'),
    marginLeftTwips: pageTwips(style.page.margins.left, 'margin'),
    titleFontFamily: style.title.fontFamily,
    bodyFontFamily: style.body.fontFamily,
    titleFontSizePt: style.title.fontSizePt,
    bodyFontSizePt: style.body.fontSizePt,
    titleBold: style.title.bold,
    titleAlignment: style.title.alignment,
    bodyAlignment: style.body.alignment,
    firstLineIndentPt: style.body.firstLineIndentPt,
    lineSpacing: style.body.lineSpacing,
    paragraphSpacingBeforePt: style.body.paragraphSpacingBeforePt,
    paragraphSpacingAfterPt: style.body.paragraphSpacingAfterPt,
    signoffAlignment: style.signoff.alignment,
  };
};

type ParagraphAlignment = NewsDocumentStyleTokens['bodyAlignment'];
type DocxAlignment = (typeof AlignmentType)[keyof typeof AlignmentType];

const alignment = (value: ParagraphAlignment): DocxAlignment =>
  value === 'left'
    ? AlignmentType.LEFT
    : value === 'right'
      ? AlignmentType.RIGHT
      : value === 'justify'
        ? AlignmentType.JUSTIFIED
        : AlignmentType.CENTER;

const pointsToTwips = (points: number): number => Math.round(points * 20);
const lineToTwips = (line: number): number => Math.round(line * 240);
const forbiddenControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

const invalid = (message: string): never => {
  throw new DocumentError('DOCUMENT_CONTENT_INVALID', message);
};

const cleanTitle = (line: string): string => {
  let value = line.trim();
  value = value.replace(/^#{1,6}\s+/u, '');
  value = value.replace(/^\*\*(.+)\*\*$/u, '$1');
  value = value.replace(/^(?:标题|题目)[：:]\s*/u, '');
  return value.trim();
};

const looksLikeTitle = (line: string): boolean => {
  const value = cleanTitle(line);
  if (!value || value.length > 500) return false;
  if (!/^(?:标题|题目)[：:]/u.test(line) && /^(?:正文|新闻稿|落款|日期)/u.test(value)) return false;
  if (/[。！？.!?；;]$/u.test(value)) return false;
  return true;
};

const parseDate = (text: string): string | undefined => {
  const match = /^20(\d{2})年(\d{1,2})月(\d{1,2})日$/u.exec(text);
  if (!match) return undefined;
  const year = Number(`20${match[1]}`);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
};

const looksLikeDateText = (text: string): boolean =>
  /^20\d{2}年\d{1,2}月(?:\d{1,2}日)?$/u.test(text.trim());

const looksLikeDatePlaceholder = (text: string): boolean =>
  /^(?:[（(]?日期[）)]?|待补日期|日期待补)(?:[：:]?\s*)$/u.test(text.trim());

const footerIndices = (
  nonEmpty: readonly string[],
  _manualDateProvided: boolean,
  manualSignOffProvided = false,
  titleRecognized = false,
): { signOffIndex: number; dateIndex: number } => {
  const lastIndex = nonEmpty.length - 1;
  const lastIsDate =
    lastIndex >= 0 &&
    (parseDate(nonEmpty[lastIndex]!) !== undefined ||
      looksLikeDateText(nonEmpty[lastIndex]!) ||
      looksLikeDatePlaceholder(nonEmpty[lastIndex]!));
  if (lastIsDate) {
    const signOffIndex =
      nonEmpty.length >= 4 || (manualSignOffProvided && nonEmpty.length >= 3 && !titleRecognized)
        ? lastIndex - 1
        : -1;
    return { signOffIndex, dateIndex: lastIndex };
  }
  // No date (or placeholder) line in the text: the last line is the sign-off
  // and the date is provided manually or missing. Do not promote the
  // second-to-last line to sign-off (it is body).
  return { signOffIndex: lastIndex >= 0 ? lastIndex : -1, dateIndex: -1 };
};

export type NewsDocumentOverrides = Partial<Pick<NewsDocument, 'title' | 'signOff' | 'dateText'>>;

export const parseNewsDocument = (
  input: string,
  overrides: NewsDocumentOverrides = {},
): NewsDocument => {
  if (Buffer.byteLength(input, 'utf8') > DOCUMENT_MAX_INPUT_BYTES)
    invalid('Document input is too large');
  const normalized = input
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .trim();
  if (forbiddenControls.test(normalized) || loneSurrogate.test(normalized))
    invalid('Document contains unsupported characters');
  if (!validateNewsContent(normalized).accepted) invalid('Document content is not exportable');
  const lines = normalized.split('\n').map((line) => line.trim());
  const nonEmpty = lines.filter(Boolean);
  if (nonEmpty.length === 0) invalid('Document must include title, body, sign-off and date');
  const titleCandidate =
    nonEmpty.length > 0 && looksLikeTitle(nonEmpty[0]!) ? cleanTitle(nonEmpty[0]!) : '';
  const dateCandidateText = nonEmpty.at(-1) ?? '';
  const dateCandidate = parseDate(dateCandidateText);
  const footer = footerIndices(
    nonEmpty,
    overrides.dateText !== undefined,
    overrides.signOff !== undefined,
    Boolean(titleCandidate),
  );
  const signOffCandidate = footer.signOffIndex >= 0 ? nonEmpty[footer.signOffIndex] : undefined;
  const title = cleanTitle(overrides.title ?? titleCandidate);
  const dateText = (
    overrides.dateText ?? (dateCandidate !== undefined ? dateCandidateText : '')
  ).trim();
  const signOff = (overrides.signOff ?? signOffCandidate ?? '').trim();
  const dateStamp =
    parseDate(dateText) ?? (overrides.dateText !== undefined && dateText ? 'unknown' : undefined);
  const titleIndex = titleCandidate ? 0 : -1;
  const signOffIndex = signOffCandidate !== undefined ? footer.signOffIndex : -1;
  const dateIndex = footer.dateIndex;
  const bodyParagraphs = nonEmpty.filter(
    (_value, index) => index !== titleIndex && index !== signOffIndex && index !== dateIndex,
  );
  if (
    !title ||
    title.length > 500 ||
    !signOff ||
    dateStamp === undefined ||
    bodyParagraphs.length === 0
  )
    invalid('Document structure is invalid');
  if (
    bodyParagraphs.length > 2_000 ||
    bodyParagraphs.some((paragraph) => paragraph.length > 20_000)
  )
    invalid('Document paragraph limits were exceeded');
  return newsDocumentSchema.parse({ title, bodyParagraphs, signOff, dateText, dateStamp });
};

export const missingNewsDocumentFields = (
  input: string,
): Array<'title' | 'signOff' | 'dateText'> => {
  const normalized = input
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .trim();
  if (
    Buffer.byteLength(input, 'utf8') > DOCUMENT_MAX_INPUT_BYTES ||
    forbiddenControls.test(normalized) ||
    loneSurrogate.test(normalized) ||
    !validateNewsContent(normalized).accepted ||
    /^(?:以下(?:为|是)|分析过程|思考过程|内部说明)/imu.test(normalized)
  )
    return [];
  const nonEmpty = normalized
    ? normalized
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  const missing: Array<'title' | 'signOff' | 'dateText'> = [];
  if (!nonEmpty[0] || !looksLikeTitle(nonEmpty[0]) || nonEmpty.length < 2) missing.push('title');
  const dateText = nonEmpty.at(-1) ?? '';
  const date = parseDate(dateText);
  const footer = footerIndices(nonEmpty, false);
  if (footer.signOffIndex < 0 || !nonEmpty[footer.signOffIndex]) missing.push('signOff');
  if (date === undefined) missing.push('dateText');
  return [...new Set(missing)];
};

const run = (text: string, font: string, size: number, bold = false) =>
  new TextRun({
    text,
    size,
    font: { name: font, ascii: font, hAnsi: font, eastAsia: font, cs: font },
    color: '000000',
    bold,
  });

export const buildNewsDocx = async (
  raw: NewsDocument,
  rawStyle: Partial<NewsDocumentStyleTokens> = {},
): Promise<Uint8Array> => {
  const input = newsDocumentSchema.parse(raw);
  const style = { ...defaultStyleTokens, ...rawStyle };
  const titleSize = Math.round(style.titleFontSizePt * 2);
  const bodySize = Math.round(style.bodyFontSizePt * 2);
  const document = new Document({
    creator: 'News Writer',
    lastModifiedBy: 'News Writer',
    title: input.title,
    description: '',
    keywords: '',
    subject: '',
    styles: {
      paragraphStyles: [
        {
          id: 'NewsTitle',
          name: 'NewsTitle',
          basedOn: 'Normal',
          next: 'NewsBody',
          quickFormat: false,
          run: {
            size: titleSize,
            bold: style.titleBold,
            color: '000000',
            font: {
              name: style.titleFontFamily,
              ascii: style.titleFontFamily,
              hAnsi: style.titleFontFamily,
              eastAsia: style.titleFontFamily,
              cs: style.titleFontFamily,
            },
          },
          paragraph: {
            alignment: alignment(style.titleAlignment),
            spacing: {
              before: 0,
              after: 0,
              line: lineToTwips(style.lineSpacing),
              lineRule: LineRuleType.AUTO,
            },
          },
        },
        {
          id: 'NewsBody',
          name: 'NewsBody',
          basedOn: 'Normal',
          next: 'NewsBody',
          quickFormat: false,
          run: {
            size: bodySize,
            bold: false,
            color: '000000',
            font: {
              name: style.bodyFontFamily,
              ascii: style.bodyFontFamily,
              hAnsi: style.bodyFontFamily,
              eastAsia: style.bodyFontFamily,
              cs: style.bodyFontFamily,
            },
          },
          paragraph: {
            alignment: alignment(style.bodyAlignment),
            indent: { firstLine: pointsToTwips(style.firstLineIndentPt) },
            spacing: {
              before: pointsToTwips(style.paragraphSpacingBeforePt),
              after: pointsToTwips(style.paragraphSpacingAfterPt),
              line: lineToTwips(style.lineSpacing),
              lineRule: LineRuleType.AUTO,
            },
          },
        },
        {
          id: 'NewsSignOff',
          name: 'NewsSignOff',
          basedOn: 'Normal',
          next: 'NewsDate',
          quickFormat: false,
          run: {
            size: bodySize,
            bold: false,
            color: '000000',
            font: {
              name: style.bodyFontFamily,
              ascii: style.bodyFontFamily,
              hAnsi: style.bodyFontFamily,
              eastAsia: style.bodyFontFamily,
              cs: style.bodyFontFamily,
            },
          },
          paragraph: {
            alignment: alignment(style.signoffAlignment),
            spacing: {
              before: pointsToTwips(style.paragraphSpacingBeforePt),
              after: pointsToTwips(style.paragraphSpacingAfterPt),
              line: lineToTwips(style.lineSpacing),
              lineRule: LineRuleType.AUTO,
            },
          },
        },
        {
          id: 'NewsDate',
          name: 'NewsDate',
          basedOn: 'Normal',
          next: 'NewsBody',
          quickFormat: false,
          run: {
            size: bodySize,
            bold: false,
            color: '000000',
            font: {
              name: style.bodyFontFamily,
              ascii: style.bodyFontFamily,
              hAnsi: style.bodyFontFamily,
              eastAsia: style.bodyFontFamily,
              cs: style.bodyFontFamily,
            },
          },
          paragraph: {
            alignment: alignment(style.signoffAlignment),
            spacing: {
              before: pointsToTwips(style.paragraphSpacingBeforePt),
              after: pointsToTwips(style.paragraphSpacingAfterPt),
              line: lineToTwips(style.lineSpacing),
              lineRule: LineRuleType.AUTO,
            },
          },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: style.pageWidthTwips,
              height: style.pageHeightTwips,
              orientation: PageOrientation.PORTRAIT,
            },
            margin: {
              top: style.marginTopTwips,
              bottom: style.marginBottomTwips,
              left: style.marginLeftTwips,
              right: style.marginRightTwips,
              header: 720,
              footer: 720,
            },
          },
        },
        children: [
          new Paragraph({
            style: 'NewsTitle',
            widowControl: true,
            children: [run(input.title, style.titleFontFamily, titleSize, style.titleBold)],
          }),
          ...input.bodyParagraphs.map(
            (text) =>
              new Paragraph({
                style: 'NewsBody',
                widowControl: true,
                children: [run(text, style.bodyFontFamily, bodySize)],
              }),
          ),
          new Paragraph({
            style: 'NewsSignOff',
            children: [run(input.signOff, style.bodyFontFamily, bodySize)],
          }),
          new Paragraph({
            style: 'NewsDate',
            widowControl: true,
            children: [run(input.dateText, style.bodyFontFamily, bodySize)],
          }),
        ],
      },
    ],
  });
  try {
    const packed = new Uint8Array(await Packer.toBuffer(document));
    await auditDocxCompatibilitySource(packed);
    const zip = await JSZip.loadAsync(packed);
    const removed = ['docProps/custom.xml', 'word/comments.xml', 'word/_rels/comments.xml.rels'];
    removed.forEach((entry) => zip.remove(entry));
    const mainDocument = zip.file('word/document.xml');
    if (mainDocument) {
      const xml = await mainDocument.async('string');
      zip.file(
        'word/document.xml',
        xml
          .replace(
            /(<w:pStyle w:val="NewsBody"\/>)/gu,
            '$1<w:snapToGrid w:val="0"/><w:overflowPunct w:val="1"/>',
          )
          .replace(/(<w:pStyle w:val="NewsTitle"\/>)/gu, '$1<w:snapToGrid w:val="0"/>')
          .replace(
            /(<w:pStyle w:val="(?:NewsSignOff|NewsDate)"\/>)/gu,
            '$1<w:snapToGrid w:val="1"/>',
          ),
      );
    }
    for (const entry of ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels']) {
      const part = zip.file(entry);
      if (!part) continue;
      const xml = await part.async('string');
      zip.file(
        entry,
        xml
          .replace(/<Override\b[^>]*(?:custom\.xml|comments\.xml)[^>]*\/>/giu, '')
          .replace(/<Relationship\b[^>]*(?:custom-properties|comments)[^>]*\/>/giu, ''),
      );
    }
    const bytes = new Uint8Array(
      await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
    );
    if (bytes.byteLength === 0 || bytes.byteLength > DOCUMENT_MAX_OUTPUT_BYTES)
      throw new DocumentError('DOCUMENT_GENERATION_FAILED', 'Generated document size is invalid');
    // Validate the exact package that leaves the builder, after compatibility parts
    // and relationships have been scrubbed. This keeps malformed output from
    // reaching the atomic publisher even if the upstream docx package changes.
    await auditNewsDocx(bytes, input, [], style);
    return bytes;
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError('DOCUMENT_GENERATION_FAILED', 'DOCX generation failed');
  }
};
