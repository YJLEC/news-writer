# 0005 内置检索模块编码前独立审查

- 状态：有条件批准阶段 3 的检索核心、合成资源构建和只读加载编码
- 审查日期：2026-08-09
- 审查角色：独立 retrieval review agent
- 依据：`AGENTS.md`、`GOAL.md`、`IMPLEMENTATION_PLAN.md`、`FUNCTION_MATRIX.md`、`GOLDEN_FIXTURES_PLAN.md`、`GOLDEN_FIXTURES_REVIEW.md`、`0001` 至 `0004` 架构审查、当前 `packages/retrieval`、`domain`、`shared` 及原项目只读检索实现
- 范围：检索文本规范化、确定性中文 token、BM25、corpus/index/metadata Schema、检索报告、Prompt 引用快照、构建期与运行时边界及对应测试
- 不在范围：面向用户的知识库管理、原始 Office/PDF/PPTX 抽取器、真实学院语料入库、Prompt 总体合约、AI、Electron IPC/UI 和项目存储协议改造

## 结论

检索模块是首版写稿流程中历史参考稿和可追溯 Prompt 的必要能力，现有 `packages/retrieval` 只有常量占位符，没有可复用实现。批准在现有 package 内以纯 TypeScript 实现确定性 tokenizer 和精确 BM25，不采用 jieba 兼容层，也不引入通用全文检索引擎。

本审查批准的中文策略是固定 Unicode 码位范围上的汉字一元、二元和三元 token，加 ASCII 字母数字 token。它保留旧实现始终存在的确定性召回基础，并用黄金排序验证行为；逐 token 兼容 Python jieba 不是目标。不得把 `Intl.Segmenter` 输出加入 V1 索引或查询，因为 Node 构建环境与 Electron 运行时的 ICU 版本可能不同，升级 ICU 也会改变分词结果。

BM25 必须由小型纯函数实现，固定 `k1=1.5`、`b=0.75`、query term frequency 上限 3、正分结果和默认 Top 5。排序使用未舍入分数，分数相同则按 `documentId` 的 Unicode code point 顺序升序；检索报告和黄金断言保存六位小数的十进制舍入值。

批准 coding agent 实现：

1. `packages/retrieval` 的规范化、tokenizer、版本化 Schema、索引构建、校验、查询、检索报告映射和 Prompt 参考片段格式化。
2. 仅供开发/构建使用的文件适配器，以及主进程可调用的只读资源加载适配器；纯核心不得导入 Electron 或项目文件系统。
3. 从已批准的五篇合成 Markdown 生成测试 corpus/index/golden 的工具和测试。合成 Markdown 是唯一事实源，不创建重复的 `mini-index-input.json`。
4. 阶段 3 后续单独内容审查通过后，从 `news` 的学院稿只读构建正式可分发资源；本批准本身不授权把真实原稿、路径或未经复核文本写入仓库。

## 必要性、复用与依赖审查

### 批准的直接依赖

`packages/retrieval/package.json` 在编码阶段只能增加以下生产依赖：

| 依赖 | 精确约束 | 用途 | 结论 |
| --- | --- | --- | --- |
| `@news-writer/domain` | `workspace:*` | 使用已批准的 `RetrievalReport` Schema/类型 | 批准；不得复制一套报告 Schema |
| `@news-writer/shared` | `workspace:*` | SHA-256、时间、ID 等共享值类型 | 批准 |
| `zod` | `4.4.3` | corpus/index/metadata 和外部输入运行时校验 | 批准；调用 Zod 的 package 必须直接声明 |
| `entities` | `8.0.0` | 用标准 HTML5 规则解码 `&nbsp;`、`&amp;` 等实体 | 批准；BSD-2-Clause、纯 ESM/JS、无依赖、Node 20.19+，与固定 Node 24 基线相容 |

哈希、UTF-8、文件读取和路径解析仅在适配器中使用 `node:crypto`、`node:fs/promises`、`node:path` 和 `node:readline`。不得为这些能力再引入包。许可证门禁仍须检查实际 tarball 的 LICENSE，并把 `entities` 纳入发行 notices；npm 元数据不是最终法律证明。

### 分词候选

审查日期当日查询到的 npm 元数据如下；版本只用于记录此次判断，不构成后续自动升级许可。

| 候选 | 元数据与风险 | 结论 |
| --- | --- | --- |
| 固定 Han n-gram | 仓库内少量纯 TS，无词典、WASM、原生包或运行时资源 | **采用**；行为完全可版本化和黄金测试 |
| `Intl.Segmenter` | 无依赖，但结果绑定 Chromium/Node 的 ICU/Unicode 数据；当前开发 Node 为 ICU 78.3，不能据此假定 Electron 构建期和运行时永远一致 | 不采用为 V1 token 来源；可在未来独立评审后升级算法版本 |
| `segmentit@2.0.3` | 约 15.8 MB，npm 元数据未给出明确 license 字段，最后更新 2022 年，带构建期 macro 依赖和词典内容 | 拒绝；体积、授权和维护收益不成立 |
| `jieba-js@1.0.2` | ISC，约 8.7 MB，最后更新 2022 年，依赖旧 decorator 包 | 拒绝；维护和依赖面不值得只为非必要 jieba 兼容 |
| `jieba-wasm@2.4.0` | MIT，2025 年更新，约 16.1 MB；携带 WASM/词典并增加资源初始化和供应链审查 | 暂不采用；没有黄金质量证据证明其优于固定 n-gram |
| `@node-rs/jieba@2.0.1` | MIT，约 11.3 MB，通过多个平台 optional package 分发 N-API/WASI 二进制 | 拒绝；违反首版无运行时原生扩展基线并扩大打包面 |
| `nodejieba@3.5.8` | MIT，约 20.9 MB，依赖 `node-pre-gyp` 和 `node-addon-api` | 拒绝；存在 Electron ABI/预编译二进制和重编译风险 |

jieba 的词典切分在旧 Python 中本来就是可失败的附加项；旧实现即使 jieba 不可用，仍加入连续汉字的一元、二元和三元 token。因此 V1 不需要词典级兼容。质量门槛是固定查询的 Top K、排序和关键召回，而不是 token 列表逐项复制。

### 搜索引擎候选

| 候选 | 元数据与不适配点 | 结论 |
| --- | --- | --- |
| 自有窄 BM25 纯函数 | 公式不足 100 行核心逻辑，参数和序列化完全受控 | **采用** |
| `minisearch@7.2.0` | MIT、无依赖、维护活跃；但公开能力远超需要，其评分、字段 boost、前缀/模糊搜索和序列化契约不等于本项目固定 BM25 | 不采用；成熟但不满足精确行为基线 |
| `wink-bm25-text-search@3.1.2` | MIT，2022 年更新，拉入 wink NLP/model 依赖；内部管线和评分配置增加审计面 | 不采用 |
| `flexsearch@0.8.212` | Apache-2.0、维护活跃；使用自身索引/评分模型，不提供本项目要求的精确 BM25 契约 | 不采用 |

这不是重复造通用搜索引擎。批准范围只有单字段、只读、小语料、固定参数的 BM25，采用外部引擎反而无法保持 R05 和可解释的黄金分数。

## 规范化和 token 契约

### `normalizeRetrievalTextV1`

输入必须是字符串，按固定顺序处理：

1. 使用 `entities.decodeHTML` 解码 HTML5 命名和数字实体。
2. 执行 Unicode `NFKC`。
3. 删除 NUL；把 `U+0001..U+0008`、`U+000B`、`U+000C`、`U+000E..U+001F`、`U+007F..U+009F`、`U+2028`、`U+2029` 替换为空格，保留 LF。
4. 把 CRLF/CR 统一为 LF；每一段内连续空格、Tab、form feed 和 vertical tab 折叠为一个 ASCII 空格。
5. 三个及以上连续 LF 折叠为两个 LF，去掉行末空格，并对全文 `trim()`。

规范化不负责隐私脱敏。完整 query 管线固定为“原始纪要 -> 首次规范化 -> 经独立审查批准的脱敏器 -> 再次规范化 -> tokenize/search”；首次规范化确保全角字母数字等兼容形式不会绕过脱敏，第二次规范化清理脱敏占位符周围的边界且必须幂等。检索函数的输入名固定为 `redactedText`，避免把未脱敏纪要误当普通 query。报告中的 `redactedQueryText` 必须是第二次规范化的逐字输出，`querySha256` 是该字符串 UTF-8 bytes 的小写 SHA-256。

V1 不删除停用词、不做繁简转换、不做拼音、词干化、同义词扩展或标点改写。这些行为会改变 df、长度和排序，必须以新的 tokenizer/engine 版本另行迁移。

### `tokenizeRetrievalTextV1`

在规范化输出上执行：

- ASCII token：匹配 `[a-z0-9]+`，按 ASCII 小写输出；NFKC 已把兼容全角字符归一。
- Han 序列：按 code point 遍历固定范围 `U+3400..U+4DBF`、`U+4E00..U+9FFF`、`U+F900..U+FAFF`、`U+20000..U+2EBEF`、`U+30000..U+323AF`。相邻 Han code point 构成一个序列，其他字符终止序列。
- 对每个 Han 序列依次输出所有一元 token，再输出所有相邻二元 token，再输出所有相邻三元 token；长度不足时跳过对应 n-gram。
- 保留重复 token。document TF 和 query TF 都来自完整 token 数组；仅在 query 评分时把每个 term 的 qtf 截到 3。

不得使用 JS UTF-16 下标直接切 astral Han 字符；必须以 `Array.from` 或等价 code point 迭代。token 输出顺序属于算法契约，但索引和查询不得依赖对象属性遍历顺序。

公开算法标识固定为：

```text
normalizer: retrieval-normalizer-nfkc-html-v1
tokenizer: han-1-2-3gram-ascii-v1
engine: bm25-han-ngram-v1
```

实现逻辑变化必须提升对应标识，并重建 corpus/index；不得在标识不变时改变范围、顺序或规范化步骤。

## BM25 精确契约

对 `N` 篇文档、term 的文档频率 `df`、文档内频率 `tf`、文档长度 `dl` 和平均长度 `avgdl`：

```text
idf(term) = ln(1 + (N - df + 0.5) / (df + 0.5))
denom = tf + k1 * (1 - b + b * dl / avgdl)
termScore = idf(term) * (tf * (k1 + 1) / denom) * min(queryTf, 3)
score = sum(termScore)
```

参数固定：

```text
k1 = 1.5
b = 0.75
queryTfCap = 3
defaultTopK = 5
maximumTopK = 20
```

边界规则：

- 空 corpus 的 `documentCount=0`、`averageDocumentLength=0`，查询返回空 hits；不得用虚构的 `N=1` 写入索引。
- 非空 corpus 中每篇文档必须至少有一个 token，否则构建失败；`avgdl` 必须由所有文档实际 token 数计算。
- 空或规范化后无 token 的 query 是合法输入并返回空 hits，不抛异常。
- 只保留 raw score 有限且严格大于 0 的结果。
- 排名先按 raw IEEE-754 double score 降序；`Object.is`/严格数值相等时按 `documentId` 的 Unicode code point 顺序升序。不得使用依赖系统 locale 的 `localeCompare`。
- Top K 在排序后截断。调用值必须是 `0..20` 的整数；`0` 返回空数组。
- 排名使用 raw score，绝不能用展示/持久化舍入值决定顺序。
- 报告和黄金分数使用 `Number(rawScore.toFixed(6))` 的六位小数数值。JSON 不保留尾零，UI 如需六位显示应格式化而不改变存储值。

旧 Python 返回四位小数且同分依赖原文档迭代顺序；六位报告精度和显式 ID tie-break 是为可追溯与跨构建稳定性作出的主动修正。黄金测试必须覆盖 raw score 不同但六位舍入相同的情况。

## 资源 Schema

### corpus JSONL V1

`corpus.jsonl` 使用 UTF-8、LF、每行一个 strict object、文件末尾一个 LF；记录按 `documentId` code point 升序。最小记录：

```ts
interface KnowledgeCorpusRecordV1 {
  format: 'news-writer-knowledge-document';
  schemaVersion: 1;
  documentId: string;
  title: string;
  eventLabel?: string;
  semester?: string;
  normalizedText: string;
  contentSha256: Sha256;
}
```

`documentId` 必须匹配 `news_[0-9a-f]{24}`，由 `sha256(title + "\n" + normalizedText)` 的前 24 个 hex 生成；发生碰撞必须失败，不得覆盖。`contentSha256` 使用相同完整串的 UTF-8 hash。标题 trim 后非空；正文是已清理、脱敏、规范化的完整可分发文本，trim 后非空。可选字段无值时必须省略，不能写空字符串。

不允许 `path`、`sourcePath`、`archive`、原文件名、绝对/相对源路径、原始二进制引用、清理前正文、人员私密字段或任意扩展字段。正式 corpus 每条记录必须经过内容和隐私审查；Schema 合法不等于可分发。

### index JSON V1

索引不重复保存正文、标题或路径，只保存 BM25 所需数据：

```ts
interface RetrievalIndexV1 {
  format: 'news-writer-retrieval-index';
  schemaVersion: 1;
  engineVersion: 'bm25-han-ngram-v1';
  normalizerVersion: 'retrieval-normalizer-nfkc-html-v1';
  tokenizerVersion: 'han-1-2-3gram-ascii-v1';
  corpusSha256: Sha256;
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

所有数字必须 finite；计数为非负安全整数，文档长度和 TF 为正安全整数。documents 按 ID 升序，terms 按 term code point 升序，每个 postings 按 ID 升序。Schema 解析后还必须做交叉校验：ID 唯一且与 corpus 集合完全一致、每个 posting 引用存在、同一 term/doc 不重复、`documentFrequency === postings.length`、每篇 `length` 等于其 postings TF 总和、documentCount/avgdl 可重算一致、corpus hash 与实际 bytes 一致。运行时不得信任预存 idf，应从 df 和 N 计算。

### metadata JSON V1

`metadata.json` 至少包含：format/schemaVersion、opaque `knowledgeVersion`、构建 UTC 时间、来源范围声明、documentCount、corpus/index/training rules 的 SHA-256、三个算法版本、构建 app/tool/Node/ICU/Unicode 版本、内容审查状态和隐私审查状态。正式资源只接受两项审查状态均为 `approved`。

`knowledgeVersion` 建议为 `kw_<corpusSha256 前 16 位>_<indexSha256 前 16 位>`，只标识一组不可变资源，不表达跨 App 兼容承诺。首版按 `GOAL.md` 暂不处理不同知识库版本之间的项目兼容；历史 RetrievalReport 继续保存其 opaque 版本和实际摘录。

`training_rules.txt` 的 hash 必须由 metadata 关联，但培训规则不进入 BM25 corpus/index。运行时整体校验 metadata 与三个资源 hash；任一缺失、Schema 错误或 hash 不符都产生安全的知识库损坏错误，不允许静默重建、联网下载或回退到未校验数据。该错误码需在实现前由 shared/domain 的独立 schema 变更审查批准，不能临时塞入 `UNKNOWN` 作为长期契约。

## 接口和模块边界

纯核心建议暴露以下窄接口；名称可按现有风格微调，但输入输出和边界不得放宽：

```ts
normalizeRetrievalTextV1(text: string): string;
tokenizeRetrievalTextV1(normalizedText: string): string[];
buildRetrievalIndexV1(records: readonly KnowledgeCorpusRecordV1[]): RetrievalIndexV1;
validateKnowledgeBundleV1(bundle: KnowledgeBundleBytes): ValidatedKnowledgeBundleV1;
searchRetrievalIndexV1(
  index: RetrievalIndexV1,
  normalizedRedactedQuery: string,
  topK?: number,
): readonly RetrievalHitV1[];
buildRetrievalReportV1(input: BuildRetrievalReportInput): RetrievalReport;
formatPromptReferencesV1(report: RetrievalReport): string;
```

职责固定如下：

- normalizer/tokenizer/index/search 是无 I/O 纯函数，不导入 Electron、React、project、网络或凭据。
- hash、clock 和 ID 通过窄依赖注入或适配器提供；测试不得依赖当前时间或随机 ID。
- 构建适配器可读取明确传入的源目录并写入明确输出目录，但不在 App 菜单、preload 或 IPC 中暴露。
- runtime loader 只能从主进程解析后的 `process.resourcesPath/knowledge` 读取固定四个文件。renderer 不获得资源路径、任意文件读取或重建能力。
- retrieval 不写 Project。主进程应用服务将已验证 `RetrievalReport` 交给 project/domain 的既有事务接口。
- domain 继续拥有项目内的 `RetrievalReport` Schema。retrieval 可以生成该 DTO，不得反向让 domain 依赖检索算法或资源 Schema。

需要在编码前修正的 Schema 边界只有两项：

1. `retrievalReportSchema` 的 `querySha256` 必须校验为 `sha256(redactedQueryText UTF-8)`；现有 Schema 只校验格式。可在 retrieval builder 和项目聚合交叉校验中执行，不必把 Node crypto 引入 domain。
2. `score` 必须是按六位规则生成的非负数；domain 保持通用 finite/nonnegative 校验，精度和 raw ranking 属于 retrieval，不把算法细节下沉到 domain。

## Prompt 摘录和历史快照边界

搜索结果在 raw ranking 后按 ID 从已验证 corpus 映射，不能从 index 取正文。每篇用于 Prompt 的正文摘录按 Unicode code point 截取最多 1000 个字符并 `trim()`；不得以 UTF-16 下标切断 surrogate pair。若正文超过上限，在末尾追加固定的 `……`，该省略号属于快照文本。

`RetrievalReport.hits[].promptExcerpt` 保存上述**实际正文摘录的逐字快照**，不是 corpus 引用，也不是将来可重算的 offset。title、六位 score 和 excerpt 一起成为 report 的不可变命中快照。`formatPromptReferencesV1` 只能从 report 生成 Prompt 参考区块，不得重新打开当前知识库；其输出传入 Prompt composer 后，不得再清理、重新截断或实体解码。

PromptRecord 仍保存实际发送的完整 Prompt，因此 report 负责检索证据快照，PromptRecord 负责最终 wire 快照，两者职责不重复。Prompt 引用区块的具体标题和说明句属于后续 Prompt 合约；在该合约批准前，retrieval 测试只批准一个内部、版本化 formatter 结构测试，不创建完整生成 Prompt 黄金文件。

无命中时 report `hits=[]`，formatter 产生固定的“未检索到相似旧稿”语义块，生成流程继续。空 query 与合法但无命中的 query 必须分别记录和测试；二者都不是异常。

## Golden 和测试门槛

### 批准创建的 fixture/golden

以 `tests/fixtures/retrieval/documents/r01-*.md` 至 `r05-*.md` 为唯一输入源，批准编码 agent 生成或维护：

- 合成 `corpus.jsonl` 和 `index.json` fixture；不得另建 `mini-index-input.json`。
- normalizer 输入/输出和 tokenizer token golden。
- 至少三个 query 的 Top K ID、六位 score 和 report 快照 golden，其中包含明确命中、稳定同分和 `no-match-query.txt` 合法无命中。
- Schema 错误使用测试内最小对象构造，避免为每个反例增加大 JSON fixture。

这些生成物必须由测试或构建脚本从 Markdown 重建并比较语义内容；不对整个 index JSON 的浮点 bytes 做快照。JSON 序列化本身仍应稳定排序，便于审查和 hash。

### 必测行为

1. GF-13 的 HTML entity、Tab、连续空行和中文标点规范化精确通过；NUL、C0/C1、CRLF 和 NFKC 使用测试内字符串覆盖。
2. ASCII 大小写/全角、单字 Han、BMP 和 astral Han、重复词、混合标点的 token 精确通过。
3. 五篇合成文档的 document ID、长度、df、postings、avgdl 可重算；构建两次结果一致。
4. BM25 手算小例精确到容差 `1e-12`；qtf 1/3/4 证明 cap=3，长短文档证明 b 生效。
5. raw score 排序、完全同分 ID tie-break、raw 不同但六位相同仍按 raw 排序。
6. 默认 Top 5、Top K 0/上限/越界、正分过滤、空 query、纯标点 query、空 corpus和合法无命中。
7. report rank 从 1 连续、ID 唯一、query hash 精确、score 六位、excerpt 最多 1000 code points；知识库后来改变也不影响历史 formatter 输出。
8. corpus/index/metadata 缺字段、未知字段、重复 ID、悬空 posting、错误 df/length/avgdl/hash、NaN/Infinity、过新 schema/算法版本全部拒绝。
9. corpus、report、日志和打包资源扫描不得出现盘符、UNC、`sourcePath/path/archive` 字段、手机号、身份证、邮箱、API Key 模式或五篇合成稿以外的原项目长句。
10. runtime loader 只读，缺失/损坏资源显式失败；renderer bundle 不包含 `node:fs`、知识库源路径或构建入口。

所有测试必须能在不运行 `news` 的 Python/PowerShell、不安装 jieba 和不联网的情况下执行。正式学院 corpus 构建另需人工内容抽检、隐私扫描和来源范围记录，不能只凭单测通过宣称可分发。

## Coding agent 交付边界

编码开始前，主 agent 应给 retrieval coding agent 一份只含本模块的任务，并要求其先读取本文。该 agent 可以修改 `packages/retrieval`、必要的 workspace 引用/依赖清单、获批 retrieval fixture/golden、构建脚本和直接相关测试；涉及 `domain/shared` Schema 或错误码的改动需先由主 agent确认不破坏 `0003/0004` 边界。

编码完成后必须通过：格式、lint、typecheck、retrieval 单元测试、workspace 单元测试、构建、许可证检查和隐私/路径扫描。主 agent 还应独立复算一个 BM25 样例，检查生成 index 的确定性，并确认 `news` 无改动。

## 禁止项

- 不得引入 `nodejieba`、`@node-rs/jieba`、任何原生 addon、预编译平台包或 Electron ABI rebuild。
- 不得在 V1 使用 `Intl.Segmenter`、浏览器 locale、系统 locale 或对象插入顺序决定 token、分数或 tie-break。
- 不得引入 MiniSearch、FlexSearch、wink、数据库、搜索服务或隐藏的 fallback 搜索算法。
- 不得逐字迁移 Python，运行 Python sidecar，或在 App 运行时调用原项目脚本。
- 不得把原始 Office/PDF/PPTX/图片、原始路径、清理前正文或 `news/data/index.json` 直接复制到发行资源。
- 不得在 renderer/preload 暴露任意知识库文件读取、路径、扫描、增加、删除、重建或导入能力。
- 不得在运行时因索引损坏自动重建、下载或静默返回另一套知识库。
- 不得按文件名、mtime、源目录遍历顺序或 rounded score 推断稳定排名。
- 不得把完整 corpus 正文重复塞入 index、RetrievalReport 或日志；report 只保存实际 Prompt 摘录。
- 不得在 Prompt 生成时重新检索或从当前知识库重算历史 report。
- 不得把合法无命中当失败或阻断生成，也不得把空 query 和无命中 fixture 混为一个用例。
- 不得在未提升算法版本并重建资源时改变规范化、Han 范围、n-gram 顺序、BM25 参数、舍入或摘录规则。

满足本文依赖、算法、Schema、快照和测试约束后，阶段 3 的检索核心可以进入 coding agent；正式知识库内容入库仍须经过单独的来源、隐私和可分发性审查。
