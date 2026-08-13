# 0006 内置知识库构建与隐私门禁审查

- 状态：流水线实现和受控处理批准；真实资源进入交付包暂缓
- 审查日期：2026-08-09
- 审查范围：阶段 3 的离线语料构建、隐私门禁、索引格式、资源打包和运行时边界
- 约束来源：`AGENTS.md`、`GOAL.md`、`IMPLEMENTATION_PLAN.md`、阶段 1 功能矩阵与 fixture 门禁、阶段 2 Schema

## 结论

批准在主 agent 固化本审查边界后，由 coding agent 实现纯 TypeScript、仅开发期可调用的知识库构建器，以及基于现有 5 篇合成 retrieval fixture 的规范化、分词、BM25、Schema、哈希和确定性测试。

用户已明确指定内置知识库来源于 `news` 自带学院稿；该指令作为本项目用途授权，足以批准构建器实现以及对候选稿进行受控、离线的提取和脱敏处理，不需要等待额外授权才能开始算法与工具实现。

不批准当前直接把 `news/data/corpus.jsonl`、`news/data/index.json`、`news/data/training_rules.txt` 或 `news/sources/news_releases` 的内容复制、转换或打包进 `news_writer`。真实语料写入正式 `resources/knowledge` 并随交付包分发，仍必须等待以下两项门禁全部关闭：

1. 建立逐篇来源台账，在项目用途授权下确认每篇稿件允许以 App 内可读取的规范化文本形式在目标内部用户范围内再分发。
2. 每篇候选稿经过脱敏结果人工复核；标题和正文均不存在自然人姓名、联系方式、学号/班级、可定位个人的事实组合、源路径、文档属性或未获批准的第三方文本。

这不是实现冲突，也不阻断算法、Schema、构建器或合成 corpus 测试。`status=kept` 只表示旧整理流程选中了文件，不能替代逐篇再分发和隐私批准。若交付门禁长期无法关闭，阶段 3 仍可完成软件实现，但只能使用合成 corpus 验证，不能把它冒充为 GOAL 要求的正式内置学院稿知识库，完整首版验收也不能宣称通过。

## 只读证据与问题

旧项目的实际数据说明现成产物不适合分发：

| 证据 | 观察 | 结论 |
| --- | --- | --- |
| `scripts/ingest_sources.py` | 从旧 manifest 的 `status=kept` 行读取文件，同时保存 `path`、`source_path`、`source_archive`、`archive_entry`、清理前 `text` 和 `redacted_text` | 旧 Schema 违反无绝对路径、无清理前正文要求 |
| `scripts/build_index.py` / `news_common.py` | 索引文档再次保存 `path` 和最多 4000 字正文；`created_at` 取当前时间；同分结果没有显式次级排序 | 不可直接复制，且不能满足确定性构建 |
| `data/corpus.jsonl` | 87 条：69 条新闻、1 条规则、17 条培训页；87 条均带绝对路径和清理前正文 | 永久禁止进入分发资源 |
| `data/index.json` | 69 个索引文档，约 3.6 MB，含绝对路径、正文和 token 计数 | 永久禁止进入分发资源 |
| 旧脱敏结果 | 87 条中仅 2 条发生替换，共发现 4 个学号和 4 个微信号占位 | 正则仅覆盖显式标识符，不能证明姓名和事件组合已脱敏 |
| `data/training_rules.txt` | 前 14 条规则后附 7 页 PPT 原文，原文含真实姓名和旧送审流程 | 只能采用另行批准、重写后的规则卡，不能复制 PPT 摘录 |
| `sources/news_releases/manifest.csv` | 121 行中 69 条 kept：65 DOCX、2 DOC、2 PDF；含直接来源、ZIP/RAR 条目和开发机/源盘路径 | 仅可作为建立新 allowlist 的只读线索，不能作为新构建输入契约 |
| 授权检索 | 用户指令已授权本项目使用自带学院稿；README、summary、manifest 和规则文件中未找到逐篇明文再分发审批记录 | 可实现和受控处理，真实资源进交付包仍待逐篇门禁 |

旧 manifest、corpus 和 index 的 SHA-256 可以用于证明审查时检查的快照，但不能作为分发授权：

- manifest：`04eebac5db1c6037f2a03600cba8c8ad557a3499132611958d10eebd0ef45d3a`
- corpus：`690abbad67a87829842fc140bea517ce77cd43c333ee55188202572b172100f6`
- index：`04822842b2c14f12e31ce51b74d4b6c9f9474e63b4727ada8930b4f76f219388`
- training rules：`7e82fd3b2632c480957aceda02674042ea0928435016985ffaeae7f8bcba8c2a`

## 输入边界

### 正式输入不是旧目录扫描结果

构建器只接受显式传入的受控 source root 和 allowlist manifest。不得递归扫描目录、推断“最新文件”、读取旧 `data`，也不得接受 ZIP、RAR、图片、PPTX 或整个 Office 目录作为输入。

开发期 allowlist 至少包含：

```ts
interface ApprovedKnowledgeSourceV1 {
  sourceId: string; // 无业务含义的稳定 ID
  relativePath: string; // 相对受控 source root；不得写入分发资源
  sourceSha256: string;
  format: 'docx' | 'pdf' | 'utf8-text';
  projectPurposeAuthorizationId: string;
  redistributionScope: 'internal-app';
  redistributionReviewId: string;
  privacyReviewId: string;
  privacyReviewStatus: 'approved';
}
```

allowlist 本身是受限构建输入，不进入 App、项目目录或分发资源。构建器必须拒绝绝对路径、父目录跳转、符号链接逃逸、哈希不符、重复 source ID/hash、未批准状态和未知字段。

来源必须同时满足：

- 是原项目已经自带的学院新闻稿，不得混入 other 场景稿、活动纪要、初稿、审稿意见或项目输出。
- 每篇稿件在项目用途授权下完成内部 App 明文再分发复核；“曾公开发布”“位于内部盘”或“manifest kept”都不能自动替代该记录。
- 若稿件包含第三方转载段落、演讲稿长引、歌词或其他受保护文本，必须删除该段或取得单独许可。
- 原始媒体和容器永不进入 `news_writer` 或便携目录。

### Office/PDF 读取方案

解析器只用于开发期生成待审核文本，不进入 Electron 生产依赖：

| 格式/候选 | 决定 | 理由与限制 |
| --- | --- | --- |
| DOCX：`mammoth` 1.12.0 | 有条件批准为开发依赖候选 | BSD-2-Clause、纯 JS，使用 `extractRawText`，关闭图片处理；精确锁版并用合成 DOCX 验证段落/表格顺序。提取结果必须再经人工复核，不能直接发布。 |
| PDF：`pdfjs-dist` 6.2.108 | 有条件批准为开发依赖候选 | Apache-2.0、纯 JS；仅处理带文本层的 PDF，不做 OCR。固定逐页和行重排规则；加密、扫描件、异常字序和空结果一律拒绝。 |
| DOC：`word-extractor` 1.0.4 或自写 OLE 猜测 | 不批准 | 候选维护较旧，旧 Python 的多编码密度猜测会产生不可审计噪声。现有 2 个 DOC 默认排除；确需纳入时由数据所有者受控转换为 DOCX/UTF-8 文本，记录原文件及转换结果哈希并重新人工批准。 |
| PPTX 培训材料 | 不批准进入抽取流水线 | 规则不需要携带培训页原文。`training_rules.txt` 只从主 agent 批准的重写规则源编译。 |
| 图片/OCR/ZIP/RAR | 永久禁止 | 不属于输出范围，且显著扩大隐私、版权、解压和供应链风险。 |

上述版本是 2026-08-09 的 registry 审查快照，不授权 coding agent 直接安装。实际引入前仍需主 agent 批准、精确锁定、检查锁文件和包内 LICENSE，并确认没有原生扩展或安装脚本。

如果组织能够提供已经人工清理、UTF-8/LF 的受控文本，优先使用 `utf8-text`，省去 Office/PDF 解析歧义。该文本仍必须关联原源 SHA-256、授权和隐私审批，不能因“已转成 txt”跳过门禁。

## 离线流水线

构建分成四个不可混淆的阶段：

```text
受控原文件 + allowlist
  -> 哈希/格式/容器安全校验
  -> 内存提取候选文本
  -> 规范化 + 自动脱敏 + 人工逐篇复核
  -> 已批准的脱敏文本集合（受限构建输入）
  -> 确定性 corpus 编译
  -> 确定性 tokenizer/BM25 index 编译
  -> 规则编译 + metadata/hash
  -> 分发扫描
  -> resources/knowledge 四文件
```

原始提取文本不得写入仓库、资源目录、测试 snapshot、普通日志或构建缓存。错误日志只记录 source ID、哈希、稳定错误码和计数，不记录源路径、标题或正文。若为人工复核必须落地候选文本，只能写入仓库外的受限临时目录，设定负责人、保留期限和删除记录；该目录不是 App 构建输入的默认位置。

首版只实现全量 clean build。暂不实现增量缓存，因为缓存会增加清理前文本残留、规则升级后漏重建和跨版本污染风险。未来若开发效率确实需要增量构建，必须证明同一输入的增量结果与空目录全量构建逐字一致，并且缓存只含已经批准的脱敏文本。

## 规范化与脱敏

顺序复用 `0005-retrieval-review.md` 的 V1 契约：HTML5 实体解码 -> Unicode NFKC -> 删除 NUL/替换不允许控制字符 -> CRLF/CR 统一为 LF -> 规范横向空白、行尾空格和空行 -> 标题与正文结构化 -> 自动脱敏 -> 人工修订 -> 再次执行同一规范化与自动扫描 -> 哈希。实现必须使用 `0005` 已批准的 `entities` 依赖和 `retrieval-normalizer-nfkc-html-v1` 标识，不能在构建器中另写一套 NFC normalizer。

输出文本 trim 后使用单一末尾换行；JSON 字符串中的 `normalizedText` 使用 `trim()` 后的值，不保留末尾换行。规范化必须幂等，构建期 corpus 和运行时 query 使用同一纯函数。

自动脱敏至少检测手机号、身份证号、邮箱、学号、微信号、绝对/UNC/file URI、用户目录、API Key/Bearer 形态、Office 属性残留和控制字符。它只是发现工具，不是批准器。人工复核还必须处理：

- 自然人姓名、具体班级和内部岗位人员；
- 日期、地点、人物、组织组合形成的可定位事件；
- 标题中的姓名或独特事件标识；
- 第三方长引、演讲原文、歌词和非学院所有文本；
- 文档批注、修订、隐藏文本、页眉页脚和表格中误提取的信息。

分发 allowlist 只允许固定机构名、经批准的组织称谓和普通公共地点类别。无法可靠判断是否应保留的内容默认删除或把人员泛化为角色。替换映射和清理前文本不得进入产物。

## 分发 Schema

所有 JSON Schema 使用严格字段校验、整数边界、长度上限和未知字段拒绝。以下是逻辑形状；具体 Zod 定义由 coding agent 实现并由独立 review agent 复审。

### `corpus.jsonl`

每行一个对象，按 `documentId` 升序，UTF-8、LF、单一末尾换行：

```ts
interface KnowledgeCorpusRecordV1 {
  format: 'news-writer-knowledge-document';
  schemaVersion: 1;
  documentId: `news_${string}`;
  title: string; // 已脱敏、非空、长度受限
  eventLabel?: string;
  semester?: string;
  normalizedText: string; // 已规范化和脱敏的正文
  contentSha256: string;
}
```

不得加入 path、sourcePath、archive、entry、extension、原文件名、作者、修改时间、清理前 text、redaction mapping、完整来源 hash 或自由形式 metadata。可选 `eventLabel` 和 `semester` 只有在逐篇隐私审查明确批准且非空时才出现，否则省略。`contentSha256` 为 `title + "\n" + normalizedText` 的 UTF-8 SHA-256；`documentId` 为 `news_` 加该哈希前 24 个十六进制字符，碰撞必须失败。

### `index.json`

```ts
interface RetrievalIndexV1 {
  format: 'news-writer-retrieval-index';
  schemaVersion: 1;
  engineVersion: 'bm25-han-ngram-v1';
  normalizerVersion: 'retrieval-normalizer-nfkc-html-v1';
  tokenizerVersion: 'han-1-2-3gram-ascii-v1';
  corpusSha256: string;
  documentCount: number;
  averageDocumentLength: number;
  parameters: {
    k1: 1.5;
    b: 0.75;
    queryTfCap: 3;
    defaultTopK: 5;
    maximumTopK: 20;
    reportScoreDecimals: 6;
  };
  documents: Array<{ documentId: string; length: number }>;
  terms: Array<{
    term: string;
    documentFrequency: number;
    postings: Array<{ documentId: string; termFrequency: number }>;
  }>;
}
```

索引不重复正文、标题、来源信息或预计算 IDF。documents 按 ID、terms 按 term、postings 按 ID 使用明确的 Unicode code-point 升序，不依赖 locale、文件遍历顺序或对象属性顺序。运行时从 `N` 和 `documentFrequency` 计算 IDF，并按 `0005` 的交叉校验规则复算文档长度、df、avgdl 和 corpus hash。

### `training_rules.txt`

纯文本只包含经批准、重写后的规则卡，不附 PPT 页原文、人员姓名、图片/压缩包送审细节或旧脚本说明。规则源的版本和 SHA-256 写入 metadata；文件使用 UTF-8、LF 和单一末尾换行。

### `metadata.json`

```ts
interface KnowledgeMetadataV1 {
  format: 'news-writer-knowledge-metadata';
  schemaVersion: 1;
  knowledgeVersion: string;
  builtAt: string;
  sourceScope: 'approved-built-in-college-news';
  sourceSetSha256: string;
  authorizationBatchId: string;
  privacyReviewBatchId: string;
  contentReviewStatus: 'approved';
  privacyReviewStatus: 'approved';
  documentCount: number;
  builder: {
    version: string;
    sourceSha256: string;
    nodeVersion: string;
    icuVersion: string;
    unicodeVersion: string;
    extractorVersions: Record<string, string>;
    normalizationVersion: 'retrieval-normalizer-nfkc-html-v1';
    redactionRulesVersion: string;
  };
  retrieval: {
    engineVersion: 'bm25-han-ngram-v1';
    tokenizerVersion: 'han-1-2-3gram-ascii-v1';
    bm25: { k1: 1.5; b: 0.75; queryTermFrequencyCap: 3 };
  };
  statistics: {
    approvedSourceCount: number;
    emittedDocumentCount: number;
    rejectedSourceCount: number;
    duplicateCount: number;
    redactionCountsByCategory: Record<string, number>;
    totalCharacters: number;
    totalTokens: number;
  };
  artifacts: {
    corpus: { sha256: string; byteLength: number };
    index: { sha256: string; byteLength: number };
    trainingRules: { sha256: string; byteLength: number };
  };
  bundleContentSha256: string;
}
```

`metadata.json` 只保存批次级 opaque 审批 ID 和统计，不保存逐篇文件名、路径、标题、来源 URL、审查人姓名、拒绝原因正文或替换值。详细审计台账属于受限构建记录，不随 App 分发。

## 确定性、版本和哈希

- 依赖和 Node 版本精确锁定；构建环境固定 `TZ=UTC`、locale、换行和排序函数。
- 文件遍历不决定输出；allowlist 先按 source ID 排序，最终 corpus 按内容派生 document ID 排序。
- `builtAt` 必须由发布流程显式传入合法 RFC 3339 UTC 值，禁止在编译器内部读取当前时间。相同输入若使用相同 `builtAt`，四个文件必须逐字一致。
- JSON 使用一个 canonical serializer：固定键顺序、无非有限数字、UTF-8、LF、单一末尾换行。JSONL 每行也使用同一规则。
- `sourceSetSha256` 对排序后的 `(sourceId, sourceSha256, project authorization ID, redistribution/privacy review IDs)` canonical 列表求哈希，不包含路径。
- `bundleContentSha256` 对 corpus、index、training rules 三个 artifact hash 的 canonical 组合求哈希，不包含 metadata，避免自引用。
- `knowledgeVersion` 复用 `0005` 的 `kw_<corpusSha256 前 16 位>_<indexSha256 前 16 位>`。规则变化由 `trainingRules` hash 和 `bundleContentSha256` 标识；仅审批台账或 build time 变化不伪装成检索知识版本变化。
- `builder.sourceSha256` 覆盖构建器源文件集合；依赖版本另列。发布记录在 metadata 外再保存四个最终文件哈希，以校验 metadata 自身。

## 检索算法决定

首版不引入原生 jieba，也不复刻其环境相关词典结果。完整复用 `0005` 的 `han-1-2-3gram-ascii-v1`：ASCII 连续字母数字小写 token；在固定 Han 范围 `U+3400..U+4DBF`、`U+4E00..U+9FFF`、`U+F900..U+FAFF`、`U+20000..U+2EBEF`、`U+30000..U+323AF` 内按 Unicode code point 生成 1、2、3-gram，其他字符作为边界。它保留旧实现的核心召回特征，但不要求 token 逐项兼容。

BM25 固定为旧业务基线的 `k1=1.5`、`b=0.75`、query term frequency cap 3，IDF 使用 `log(1 + (N - df + 0.5) / (df + 0.5))`。内部使用 JS double，检索报告分数统一四舍五入到 6 位小数；排序先按未舍入 score 降序，再按 `documentId` code-point 升序。仅正分命中进入结果，默认 top-k 为 5。

已检查的开源候选中，`minisearch` 7.2.0 是 MIT、纯 JS、零依赖，但其评分扩展和序列化格式会把当前透明契约绑定到库版本；`wink-bm25-text-search` 3.1.2 依赖英文 NLP 模型，不适合本项目中文 tokenizer。当前不引入二者。BM25 公式和 n-gram tokenizer 规模小、已有明确数学基线和黄金样例，直接 TypeScript 实现比适配不相符的库更容易审计；任何扩展 fuzzy/prefix/同义词能力都须重新审查。

`tests/fixtures/retrieval/documents` 下 5 篇全合成 Markdown 是唯一 retrieval 测试源。测试时由构建器生成 mini corpus/index 到临时目录，不能手写第二份 index 输入或把真实知识库缩小复制为 fixture。

## 运行时和打包边界

- 构建 CLI、提取依赖、allowlist、受限文本、审批台账和原始来源不进入 Electron 包。
- `electron-builder` 的 `extraResources` 只白名单复制 `corpus.jsonl`、`index.json`、`training_rules.txt`、`metadata.json` 到固定 knowledge 目录；不使用目录通配复制。
- 打包后扫描完整便携目录，除四个允许文件外拒绝 knowledge 目录中的任何文件；全产物拒绝 DOC/DOCX/PDF/PPTX、图片、ZIP/RAR、manifest、测试 fixture、Python、绝对路径和已知敏感模式。
- 打包验收重新计算 metadata 所列三个 artifact hash，并对 metadata 本身保存发布清单 hash；篡改、缺失、额外文件或 Schema 不符均失败。
- 运行时仅 main/受控 worker 从 `process.resourcesPath` 解析固定目录。renderer、preload 和项目存储不能接收任意资源路径，也不能直接读取 corpus/index。
- 加载时先限制文件大小和记录数，再做严格 Schema、UTF-8、hash、documentId、corpus/index 交叉引用和统计一致性校验。校验失败时禁止使用任何命中片段，返回稳定的 knowledge resource 错误；不得回退读取旧 `news` 或重新构建。
- 检索可在 Worker Thread 执行。主进程只接收已校验查询和 top-k，renderer 只获得受控检索报告 DTO；项目保存实际进入 Prompt 的摘录、命中 ID/分数和知识库版本，不保存资源路径或整篇 corpus。

知识库是可读取的明文产品资源，哈希和 asar 不能视为加密或访问控制。因此来源授权必须明确覆盖这种分发形态。

## 开发工具不是用户功能

离线构建命令只能存在于仓库开发脚本和 CI/发布流程，不得：

- 出现在 renderer 菜单、设置、命令面板或帮助入口；
- 通过 preload/IPC 暴露 ingest、add、delete、scan、rebuild 或选择 source root；
- 在 App 启动、项目归档或用户导入稿件时自动运行；
- 把用户项目、outputs、导出稿或批注加入知识库；
- 在运行时安装解析器、调用 Office/Python/PowerShell 或访问原 `news`。

首版不实现增量构建。未来开发期 full rebuild 或增量优化都不是用户知识库管理能力，但仍需独立门禁和发布审批。

## 统计、扫描和验收

每次受控构建必须产生不随 App 分发的详细审计报告，以及 metadata 中不敏感的聚合统计。至少记录：allowlist 数、哈希通过数、提取成功/失败数、批准/拒绝数、空文本数、精确重复数、各类替换计数、逐格式数量、字符/token 总量、四个输出大小和哈希。

真实资源发布必须同时满足：

1. 授权：项目用途授权有效；每个 source ID 均有逐篇 `internal-app` 再分发复核引用；零未知、零过期、零超范围来源。
2. 隐私：每个输出文档均有人工作出的批准记录；敏感模式、绝对路径、Office 属性、密钥和未批准专名扫描为零命中。
3. 内容：零清理前正文、零 PPT 页原文、零 source/archive/path 字段、零空文档、零未处理提取警告、零重复正文。
4. 确定性：在两个空临时目录使用同一输入和 `builtAt` 全量构建，四个输出逐字节相同；打乱 allowlist 顺序后仍相同。
5. Schema：四文件严格解析；corpus ID/hash、index 引用、metadata 数量和 artifact hash 全部闭合。
6. 检索：GF-07 固定查询的 top-k、6 位分数和 tie-break 通过；空查询与合法无命中查询分别通过；索引损坏和 corpus/index 不一致被拒绝。
7. 规则：`training_rules.txt` 只含批准规则卡；与旧 PPT/原稿执行连续 16 个汉字长句扫描，所有命中逐条人工批准。
8. 打包：便携目录中 knowledge 资源恰好四个，且全产物禁止扩展、原始资料、开发路径、凭据和构建工具扫描通过。
9. 运行时：损坏资源不会把未校验正文送入 Prompt；检索报告符合阶段 2 `RetrievalReport` Schema，`knowledgeVersion` 和 `retrievalEngineVersion` 准确关联。

负向测试必须覆盖：路径穿越、符号链接逃逸、hash mismatch、未知扩展、ZIP/PPTX/图片、未授权状态、加密/空 PDF、DOC 输入、恶意超大 XML/ZIP、无效 UTF-8、NUL/U+FFFD、姓名/联系方式、重复 source/content、非有限 IDF、篡改 metadata 和多余资源文件。

## 与既有决策的关系

- `GOAL.md` 要求知识库来自原项目自带学院新闻稿；本审查没有改为永久使用合成语料。合成语料只用于测试，真实资源仍受授权和隐私门禁约束。
- 阶段 1 fixture 门禁禁止真实旧稿进入 `tests`；它不禁止经授权、彻底脱敏后的正式资源进入 `resources/knowledge`。两者目录、用途和审批链不同，不冲突。
- `GOAL.md` 要求 metadata 有构建时间，同时要求可复现；显式注入 `builtAt` 同时满足两者，不读取墙钟。
- “纯 TypeScript 产品”不排斥锁定的纯 JS 开发期解析器；这些解析器不进入运行时。受控 Office 转换仅是数据所有者准备输入的外部步骤，不是产品 sidecar。
- 当前唯一无法由代码消除的问题是逐篇明文再分发复核和隐私批准；项目用途本身已由用户授权，不阻断实现。主 agent 不应通过降低脱敏标准、把路径字段删掉后直接复制旧 corpus，或把 asar 当保护来绕过交付门禁。

## coding agent 准入范围

主 agent 批准后，可以开始：

- 在 `packages/retrieval` 实现严格 Schema、规范化、确定性 tokenizer/BM25、只读加载和合成 fixture 测试。
- 实现仅开发期的构建编排、canonical serializer、hash/metadata、allowlist 校验和分发扫描。
- 使用 5 篇已批准合成 Markdown 在临时目录生成 mini corpus/index 并完成正反测试。
- 为 DOCX/PDF 解析器建立独立开发依赖门禁或适配器接口；只有主 agent 批准锁文件变化后才能安装。

暂不允许：

- 生成或提交真实 `resources/knowledge` 四文件；
- 复制旧 corpus/index/training rules，或把旧 manifest 当已批准 allowlist；
- 读取、转换或提交 69 篇真实稿件的正文结果；
- 实现运行时重建、用户知识库管理或增量缓存；
- 引入 `.doc` 解析、OCR、压缩包处理、原生分词器或 Python/PowerShell。

实现完成后必须由另一名独立 review agent 检查依赖必要性、隐私失败关闭、确定性、Schema/hash 闭合、打包白名单和对旧项目的零运行时依赖。真实语料门禁另行签核，不能由代码 review 代替。
