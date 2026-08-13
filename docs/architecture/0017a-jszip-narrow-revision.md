# 0017a Stage 7 JSZip 窄范围修订

日期：2026-08-11

状态：批准，受本文件边界约束。

## 原因

`docx@9.7.1` 即使未配置批注和自定义属性，也会生成固定的空 comments/custom
部件；其公开 API 也不能表达模板要求的段落级 `w:pPr/w:snapToGrid`。因此，0017
中“不直接选择 JSZip”的结论修订为允许一个受限、可审计的兼容层。

## 允许范围

- 仅删除 `docx@9.7.1` 固定生成的空 comments/custom 部件，并同步清理其固定
  content-type 与 relationship 项。
- scrub 前的 `word/comments.xml` 必须与 `docx@9.7.1` 固定空结构精确一致；任何
  `w:comment`（包括 `w:id="0"`、负数 ID）、正文、额外属性或命名空间变化均拒绝。
- scrub 后仍允许存在的 `word/footnotes.xml` 与 `word/endnotes.xml` 必须分别精确匹配
  `docx@9.7.1` 固定的 separator/continuationSeparator 结构；不得含普通 note、`w:t`、
  隐藏 token 或额外属性。
- 仅补充段落级 `w:pPr/w:snapToGrid` token。
- patch 前扫描原始产物，patch 后执行严格 parts、content-types、relationships、
  token、可见文本和隐私审计。

## 禁止范围

- 不得用 JSZip 创建或改写正文、样式主体、关系图或通用模板系统。
- 不得扩大为任意 OOXML 编辑器、手写 DOCX fallback 或未知部件修复器。
- `docx` 版本、允许删除的固定部件或 token 结构变化时，必须重新独立审查。

本修订不改变 0017 的 A4 模板、内容纯净、实际渲染和 Word 视觉验收门禁。
