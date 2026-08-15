import JSZip from 'jszip';

import type { DocumentStyleTokens, NewsDocument } from './contracts.js';

const defaultAuditStyle: DocumentStyleTokens = {
  pageWidthTwips: 11906,
  pageHeightTwips: 16838,
  marginTopTwips: 1440,
  marginRightTwips: 1800,
  marginBottomTwips: 1440,
  marginLeftTwips: 1800,
  titleFontFamily: '方正小标宋简体',
  bodyFontFamily: '仿宋_GB2312',
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

const allowedParts = new Set([
  '[Content_Types].xml',
  '_rels/.rels',
  'docProps/app.xml',
  'docProps/core.xml',
  'word/_rels/document.xml.rels',
  'word/_rels/endnotes.xml.rels',
  'word/_rels/fontTable.xml.rels',
  'word/_rels/footnotes.xml.rels',
  'word/document.xml',
  'word/endnotes.xml',
  'word/fontTable.xml',
  'word/footnotes.xml',
  'word/numbering.xml',
  'word/settings.xml',
  'word/styles.xml',
]);
const allowedContentTypes = new Set([
  'application/vnd.openxmlformats-package.relationships+xml',
  'application/xml',
  'image/png',
  'image/jpeg',
  'image/bmp',
  'image/gif',
  'image/svg+xml',
  'application/vnd.openxmlformats-officedocument.obfuscatedFont',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
  'application/vnd.openxmlformats-package.core-properties+xml',
  'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml',
]);
const allowedRelationship = new Map([
  [
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
    'word/document.xml',
  ],
  [
    'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
    'docProps/core.xml',
  ],
  [
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
    'docProps/app.xml',
  ],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles', 'styles.xml'],
  [
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
    'numbering.xml',
  ],
  [
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes',
    'footnotes.xml',
  ],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes', 'endnotes.xml'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings', 'settings.xml'],
  [
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable',
    'fontTable.xml',
  ],
]);

export interface DocumentAudit {
  entries: readonly string[];
  visibleText: readonly string[];
  clean: boolean;
}

const compatibilityOnlyParts = new Set([
  'docProps/custom.xml',
  'word/comments.xml',
  'word/_rels/comments.xml.rels',
]);

const emptyCommentsXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" xmlns:cx1="http://schemas.microsoft.com/office/drawing/2015/9/8/chartex" xmlns:cx2="http://schemas.microsoft.com/office/drawing/2015/10/21/chartex" xmlns:cx3="http://schemas.microsoft.com/office/drawing/2016/5/9/chartex" xmlns:cx4="http://schemas.microsoft.com/office/drawing/2016/5/10/chartex" xmlns:cx5="http://schemas.microsoft.com/office/drawing/2016/5/11/chartex" xmlns:cx6="http://schemas.microsoft.com/office/drawing/2016/5/12/chartex" xmlns:cx7="http://schemas.microsoft.com/office/drawing/2016/5/13/chartex" xmlns:cx8="http://schemas.microsoft.com/office/drawing/2016/5/14/chartex" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:aink="http://schemas.microsoft.com/office/drawing/2016/ink" xmlns:am3d="http://schemas.microsoft.com/office/drawing/2017/model3d" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid" xmlns:w16="http://schemas.microsoft.com/office/word/2018/wordml" xmlns:w16sdtdh="http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash" xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"/>';

const noteNamespaces =
  'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 w15 wp14"';

const fixedNotesXml = (kind: 'footnote' | 'endnote'): string => {
  const collection = `${kind}s`;
  const referenceStyle = kind === 'footnote' ? 'FootnoteReference' : 'EndnoteReference';
  const standalone = kind === 'footnote' ? ' standalone="yes"' : '';
  const note = (type: 'separator' | 'continuationSeparator', id: '-1' | '0'): string =>
    `<w:${kind} w:type="${type}" w:id="${id}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rStyle w:val="${referenceStyle}"/></w:rPr><w:${kind}Ref/></w:r><w:r><w:${type}/></w:r></w:p></w:${kind}>`;
  return `<?xml version="1.0" encoding="UTF-8"${standalone}?><w:${collection} ${noteNamespaces}>${note('separator', '-1')}${note('continuationSeparator', '0')}</w:${collection}>`;
};

export const auditDocxCompatibilitySource = async (bytes: Uint8Array): Promise<void> => {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const entries = Object.keys(zip.files).filter((entry) => !zip.files[entry]!.dir);
  if (entries.some((entry) => !allowedParts.has(entry) && !compatibilityOnlyParts.has(entry)))
    throw new Error('DOCX source package contains an unexpected part');
  if (![...compatibilityOnlyParts].every((entry) => entries.includes(entry)))
    throw new Error('DOCX source compatibility parts changed');
  const comments = await zip.file('word/comments.xml')!.async('string');
  const custom = await zip.file('docProps/custom.xml')!.async('string');
  if (comments !== emptyCommentsXml || /<property\b/u.test(custom))
    throw new Error('DOCX source compatibility parts are not empty');
};

const decodeXml = (value: string): string =>
  value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');

export const auditNewsDocx = async (
  bytes: Uint8Array,
  expected: NewsDocument,
  forbiddenSentinels: readonly string[] = [],
  style: DocumentStyleTokens = defaultAuditStyle,
): Promise<DocumentAudit> => {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const entries = Object.keys(zip.files)
    .filter((entry) => !zip.files[entry]!.dir)
    .toSorted();
  const required = [
    '[Content_Types].xml',
    '_rels/.rels',
    'docProps/app.xml',
    'docProps/core.xml',
    'word/document.xml',
    'word/styles.xml',
    'word/settings.xml',
  ];
  if (
    required.some((entry) => !entries.includes(entry)) ||
    entries.some((entry) => !allowedParts.has(entry)) ||
    entries.length !== allowedParts.size
  )
    throw new Error('DOCX package contains invalid parts');
  const xmlEntries = entries.filter((entry) => entry.endsWith('.xml') || entry.endsWith('.rels'));
  const xml = (
    await Promise.all(xmlEntries.map(async (entry) => await zip.file(entry)!.async('string')))
  ).join('\n');
  if (
    /<w:(?:ins|del|moveFrom|moveTo|hiddenText|vanish|webHidden|fldChar|instrText|fldSimple|object|altChunk|control)\b/iu.test(
      xml,
    ) ||
    /<(?:o:OLEObject|w14:checkbox)\b/iu.test(xml) ||
    /TargetMode=["']External["']/iu.test(xml)
  )
    throw new Error('DOCX package contains forbidden OOXML');
  if (forbiddenSentinels.some((sentinel) => sentinel.length > 0 && xml.includes(sentinel)))
    throw new Error('DOCX package leaked internal data');
  const contentTypes = await zip.file('[Content_Types].xml')!.async('string');
  const declaredTypes = [...contentTypes.matchAll(/ContentType="([^"]+)"/gu)].map(
    (match) => match[1]!,
  );
  if (declaredTypes.some((type) => !allowedContentTypes.has(type)))
    throw new Error('DOCX content type is not allowed');
  for (const entry of entries.filter((entry) => entry.endsWith('.rels'))) {
    const relationships = await zip.file(entry)!.async('string');
    for (const match of relationships.matchAll(/<Relationship\b([^>]*)\/>/gu)) {
      const attributes = match[1] ?? '';
      const type = /\bType="([^"]+)"/u.exec(attributes)?.[1];
      const target = /\bTarget="([^"]+)"/u.exec(attributes)?.[1];
      if (!type || !target || allowedRelationship.get(type) !== target)
        throw new Error('DOCX relationship is not allowed');
    }
  }
  const documentXml = await zip.file('word/document.xml')!.async('string');
  const footnotesXml = await zip.file('word/footnotes.xml')!.async('string');
  const endnotesXml = await zip.file('word/endnotes.xml')!.async('string');
  if (footnotesXml !== fixedNotesXml('footnote') || endnotesXml !== fixedNotesXml('endnote'))
    throw new Error('DOCX note stories are not the fixed empty structures');
  const visibleText = [...documentXml.matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/gsu)].map((match) =>
    decodeXml(match[1] ?? ''),
  );
  const expectedText = [
    expected.title,
    ...expected.bodyParagraphs,
    expected.signOff,
    expected.dateText,
  ];
  if (JSON.stringify(visibleText) !== JSON.stringify(expectedText))
    throw new Error('DOCX visible text differs from source');
  const styles = await zip.file('word/styles.xml')!.async('string');
  for (const style of ['NewsTitle', 'NewsBody', 'NewsSignOff', 'NewsDate']) {
    if (!styles.includes(`w:styleId="${style}"`)) throw new Error(`DOCX style ${style} is missing`);
  }
  if (
    !documentXml.includes(`w:w="${style.pageWidthTwips}"`) ||
    !documentXml.includes(`w:h="${style.pageHeightTwips}"`) ||
    !documentXml.includes(`w:left="${style.marginLeftTwips}"`)
  )
    throw new Error('DOCX page geometry is invalid');
  const styleBlock = (id: string): string => {
    const match = new RegExp(`<w:style\\b[^>]*w:styleId="${id}"[\\s\\S]*?<\\/w:style>`, 'u').exec(
      styles,
    );
    if (!match) throw new Error(`DOCX style ${id} is missing`);
    return match[0];
  };
  const assertTokens = (block: string, tokens: readonly RegExp[], label: string): void => {
    if (tokens.some((token) => !token.test(block)))
      throw new Error(`DOCX ${label} tokens are invalid`);
  };
  assertTokens(
    styleBlock('NewsTitle'),
    [
      new RegExp(
        `w:jc w:val="${style.titleAlignment === 'center' ? 'center' : style.titleAlignment}"`,
      ),
      new RegExp(`w:line="${Math.round(style.lineSpacing * 240)}"`),
      new RegExp(`w:sz w:val="${Math.round(style.titleFontSizePt * 2)}"`),
      new RegExp(`w:ascii="${escapeRegExp(style.titleFontFamily)}"`),
      new RegExp(`w:hAnsi="${escapeRegExp(style.titleFontFamily)}"`),
      new RegExp(`w:eastAsia="${escapeRegExp(style.titleFontFamily)}"`),
      new RegExp(`w:cs="${escapeRegExp(style.titleFontFamily)}"`),
    ],
    'title',
  );
  assertTokens(
    styleBlock('NewsBody'),
    [
      new RegExp(
        `w:jc w:val="${style.bodyAlignment === 'justify' ? 'both' : style.bodyAlignment}"`,
      ),
      new RegExp(`w:firstLine="${Math.round(style.firstLineIndentPt * 20)}"`),
      new RegExp(`w:line="${Math.round(style.lineSpacing * 240)}"`),
      new RegExp(`w:sz w:val="${Math.round(style.bodyFontSizePt * 2)}"`),
      new RegExp(`w:ascii="${escapeRegExp(style.bodyFontFamily)}"`),
      new RegExp(`w:hAnsi="${escapeRegExp(style.bodyFontFamily)}"`),
      new RegExp(`w:eastAsia="${escapeRegExp(style.bodyFontFamily)}"`),
      new RegExp(`w:cs="${escapeRegExp(style.bodyFontFamily)}"`),
    ],
    'body',
  );
  assertTokens(
    styleBlock('NewsSignOff'),
    [
      new RegExp(`w:jc w:val="${style.signoffAlignment}"`),
      new RegExp(`w:line="${Math.round(style.lineSpacing * 240)}"`),
      /w:lineRule="auto"/u,
    ],
    'sign-off',
  );
  assertTokens(
    styleBlock('NewsDate'),
    [
      new RegExp(`w:jc w:val="${style.signoffAlignment}"`),
      new RegExp(`w:line="${Math.round(style.lineSpacing * 240)}"`),
      /w:lineRule="auto"/u,
    ],
    'date',
  );
  assertTokens(styleBlock('NewsTitle'), [/w:lineRule="auto"/u], 'title line rule');
  assertTokens(styleBlock('NewsBody'), [/w:lineRule="auto"/u], 'body line rule');
  if (
    (documentXml.match(/<w:snapToGrid w:val="0"\/>/gu) ?? []).length !==
    expected.bodyParagraphs.length + 1
  )
    throw new Error('DOCX title and body paragraphs do not disable grid snapping');
  if ((documentXml.match(/<w:snapToGrid w:val="1"\/>/gu) ?? []).length !== 2)
    throw new Error('DOCX sign-off and date paragraphs do not snap to the document grid');
  if (
    (documentXml.match(/<w:overflowPunct w:val="1"\/>/gu) ?? []).length !==
    expected.bodyParagraphs.length
  )
    throw new Error('DOCX body paragraphs do not preserve hanging punctuation');
  if (
    (documentXml.match(/<w:widowControl\/>/gu) ?? []).length !==
    expected.bodyParagraphs.length + 2
  )
    throw new Error('DOCX widow control is invalid');
  for (const token of [
    `w:top="${style.marginTopTwips}"`,
    `w:right="${style.marginRightTwips}"`,
    `w:bottom="${style.marginBottomTwips}"`,
    `w:left="${style.marginLeftTwips}"`,
    'w:header="720"',
    'w:footer="720"',
  ])
    if (!documentXml.includes(token)) throw new Error('DOCX margins are invalid');
  const core = await zip.file('docProps/core.xml')!.async('string');
  if (
    !core.includes('<dc:creator>News Writer</dc:creator>') ||
    !core.includes('<cp:lastModifiedBy>News Writer</cp:lastModifiedBy>')
  )
    throw new Error('DOCX metadata identity is invalid');
  return { entries, visibleText, clean: true };
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
