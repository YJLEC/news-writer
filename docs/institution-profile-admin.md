# 机构 Profile 管理员指南

本指南面向负责制作机构专属 News Writer 的管理员。管理员准备材料、生成 profile、构建 Windows 便携目录并完成验收；普通用户只接收最终便携目录，不接触 staging、原始稿件、审核记录或字体授权材料。

## 交付结构

最终 profile 目录只能包含以下资源：

```text
profile-output/
  manifest.json
  institution.json
  rules/
    writing-rules.json
    prompt-contract.json
    document-style.json
  knowledge/
    corpus.jsonl
    index.json
    training_rules.txt
    metadata.json
  fonts/
    manifest.json
    <approved font files>
```

`manifest.json` 会记录各资源的 SHA-256、字节数、profile 版本、知识库版本、审核状态和构建时间。构建器会重新计算并校验这些值，不能手工伪造或事后修改。

## 文件和字段要求

### `institution.json`

该文件描述机构的业务默认值，不描述具体新闻事件。字段如下：

| 字段 | 要求 |
| --- | --- |
| `format` | 固定为 `news-writer-institution-config` |
| `schemaVersion` | 固定为 `1` |
| `displayName` | 对用户显示的机构名称；不得包含联系方式、账号或内部路径 |
| `defaultNewsType` | `college-news` 或 `other-news` |
| `officialPublisher` | 学院新闻的正式发布/落款主体 |
| `permittedPublisherSources` | 其他新闻允许使用的发布主体来源，例如部门、社团或实践队；只列名称，不写个人联系方式 |
| `targetChannels` | 可选渠道，如官网、公众号、校内平台 |
| `dateDisplayRule` | 日期写法和缺失日期处理规则，例如“使用用户确认的日期，不自行推断” |
| `defaultWordCountRecommendation` | 推荐正文长度；必须是正整数，不能替代用户对篇幅的最终控制 |
| `preferredTerms` | 应优先使用的机构称谓、专有名词或规范表达 |
| `forbiddenTerms` | 不应使用的简称、夸张表达或不符合机构规范的词语 |
| `externalOrganizerRules` | 主办、承办、协办、参与等关系的叙述规则；只能要求按已提供事实表述 |

示例：

```json
{
  "format": "news-writer-institution-config",
  "schemaVersion": 1,
  "displayName": "示例学院",
  "defaultNewsType": "college-news",
  "officialPublisher": "示例学院新闻中心",
  "permittedPublisherSources": ["示例学院团委", "示例学院学生会"],
  "targetChannels": ["官网", "校内平台"],
  "dateDisplayRule": "使用用户确认的日期；缺失日期时要求补充，不自行推断。",
  "defaultWordCountRecommendation": 1200,
  "preferredTerms": ["示例学院", "活动纪要"],
  "forbiddenTerms": ["网红打卡", "据悉"],
  "externalOrganizerRules": "只有纪要明确提供主办、承办或参与关系时才写入正文。"
}
```

### `rules/writing-rules.json`

这里放结构化写作规则。每条规则包含：

- `id`：稳定的小写标识，格式如 `rule_title-structure`。
- `text`：一条可执行规则，最多 2000 字符。
- `level`：`hard-constraint` 表示必须遵守，`style-guidance` 表示风格建议。
- `scenarios`：适用场景，如 `college-news`、`other-news`、`all`。

适合写入的内容：标题结构、首段信息顺序、段落组织、机构称谓、主办承办表述、结尾风格和渠道语气。不应写入 API Key、文件路径、个人隐私、审核过程或要求模型忽略事实边界的指令。

```json
{
  "format": "news-writer-writing-rules",
  "schemaVersion": 1,
  "version": "writing-v1",
  "rules": [
    {
      "id": "rule_title-structure",
      "text": "标题应概括活动核心事项，避免口号化和未经纪要支持的评价。",
      "level": "hard-constraint",
      "scenarios": ["all"]
    },
    {
      "id": "rule_body-tone",
      "text": "正文使用正式、简洁、可核验的新闻稿语气。",
      "level": "style-guidance",
      "scenarios": ["college-news"]
    }
  ]
}
```

### `rules/prompt-contract.json`

这里放三个流程阶段的机构化 Prompt 片段：

- `sections.initialDraft`：初稿规则。
- `sections.secondReview`：二次审稿关注点。
- `sections.commentRevision`：按照批注续改时的规则。
- `organizationTerms`：必须正确使用的机构名称或称谓。
- `forbiddenInstructions`：不得出现在最终 Prompt 中的指令模式。

Prompt contract 只能补充机构写作语义，不能要求模型编造事实、泄露凭据、忽略用户确认或把历史参考稿当作本次活动事实来源。

### `rules/document-style.json`

这里定义最终 DOCX 样式：

- `page.width`、`page.height`：通常为 `A4`。
- `page.margins`：上、右、下、左边距，例如 `25mm`。
- `title`：标题字体、字号、对齐、粗体和行距。
- `body`：正文字体、字号、对齐、首行缩进、行距和段前/段后距。
- `signoff`：落款对齐方式和日期格式。
- `fileNameRule`：导出文件命名规则。
- `fontFamilies`：样式实际使用的字体 family 列表。

字体名称必须与目标 Windows 环境中的实际字体一致。仅在获得明确再分发许可时才放入字体文件；否则只填写样式所需字体并在交付说明中要求管理员预装。

### `knowledge/corpus.jsonl`、`index.json`、`metadata.json`

管理员通常不手写这三个文件，而是提供已审核的 source manifest 和 candidate，由构建器生成：

- `corpus.jsonl`：每行一个规范化新闻稿，包含标题、正文、确定性 document ID 和内容 hash；不得包含原始文件名、绝对路径、Office 元数据或未审核内容。
- `index.json`：由 corpus 确定性生成的 BM25 索引，不能手工编辑。
- `metadata.json`：记录知识库版本、来源集合 hash、审核批次、构建器版本、检索算法和统计信息。
- `training_rules.txt`：知识库检索和写作训练规则；必须以 UTF-8 文本保存并以单个换行结尾。

候选稿必须是已经脱敏、规范化并人工审核的 JSON，不能把原始 DOCX/PDF 直接改名为 candidate。source manifest 中每个来源必须有：来源 ID、源文件 hash、文件格式、用途授权、隐私审核 ID、再分发审核 ID 和 `approved` 状态。候选稿的 source ID 和 source hash 必须与 manifest 一一对应。

source manifest 的结构如下。它是授权和来源的登记表，不是给模型阅读的写作语料；其中的路径只用于管理员构建时定位 staging 内的源文件，绝不会进入最终 profile：

```json
{
  "format": "news-writer-knowledge-source-manifest",
  "schemaVersion": 1,
  "sourceRootSha256": "<来源集合的小写 SHA-256>",
  "sources": [
    {
      "sourceId": "src_0000000000000001",
      "relativePath": "approved/source-01.docx",
      "sourceSha256": "<源文件的小写 SHA-256>",
      "format": "docx",
      "projectPurposeAuthorizationId": "purpose-2026-01",
      "redistributionScope": "internal-app",
      "redistributionReviewId": "redistribution-review-2026-01",
      "authorizationStatus": "approved",
      "privacyReviewId": "privacy-review-2026-01",
      "privacyReviewStatus": "approved"
    }
  ]
}
```

`format` 只能是 `docx`、`pdf` 或 `utf8-text`；`relativePath` 必须是无 `..`、无绝对路径的正斜杠相对路径。`sourceSha256` 必须由管理员对原始源文件计算，不能让 AI 猜测。源文件可以留在审核 staging 中供人工复核，但不会被 profile builder 复制到输出。

### `fonts/manifest.json`

每个字体条目必须包含：

- `family`、`fileName`、`version`、`sha256`。
- `supplier`、`licenseName`、`redistributable`。
- `requiresAdministratorInstall`、`applicableStyles`。

`redistributable` 为 `true` 才能把字体二进制放入 profile；字体授权记录仍须保留在 staging，但不会进入最终包。不能用替代字体冒充目标字体，也不能在没有许可时把系统字体复制到 profile。

## 使用 AI 转换原始材料

AI 可以帮助整理格式，但不能替代授权、隐私审核和事实复核。推荐把每个机构的规则、历史稿和样式分开处理，避免 AI 把新闻事实误写成长期规则。

### 转换长期规则

把下列提示词连同脱敏后的规则材料交给 AI：

```text
你是配置数据整理助手。请把下面的机构新闻写作规范转换为 News Writer profile 的三个 JSON 文件：
1. institution.json
2. rules/writing-rules.json
3. rules/prompt-contract.json

要求：
- 只提取长期稳定的写作规则，不把具体新闻事件、个人姓名、联系方式、学号、账号、文件路径或审核意见写入规则；
- 不添加原文没有的事实；不推断机构名称、日期或发布主体；
- hard-constraint 只用于明确的必须遵守规则，普通建议使用 style-guidance；
- 保留原文措辞的事实边界，不得生成“可以编造”“忽略用户事实”等指令；
- 输出严格 JSON，不要 Markdown 代码围栏，不要解释文字；
- 所有字段必须符合本文档给出的 schema。

原始规范：
<粘贴已脱敏的规则文本>
```

AI 输出后，管理员必须检查：机构名称、发布主体、称谓、禁用词、规则级别和适用场景是否准确。

### 转换历史稿为 candidate

每篇稿件单独处理。输入应先去除作者信息、联系方式、内部路径、Office 属性和不允许再分发的内容。提示词示例：

```text
你是新闻稿语料清理助手。请把下面一篇已获授权的新闻稿转换为一个 News Writer knowledge candidate JSON。

要求：
- 第一行是标题，其余是正文；
- 只保留可公开、可复用的标题结构、段落组织和文风信息；
- 删除或替换手机号、邮箱、学号、证件号、账号、API Key、绝对路径和内部审核信息；
- 不改变事实含义，不补写缺失事实；
- title 是清理后的标题，normalizedRedactedText 是清理后的正文；
- sourceId 和 sourceSha256 必须使用管理员提供的值，不能自行生成或修改；
- redactionCounts 只记录脱敏类别及数量；
- 输出严格 JSON，不要 Markdown 代码围栏，不要解释文字。

JSON 结构：
{
  "format": "news-writer-knowledge-candidate",
  "schemaVersion": 1,
  "sourceId": "src_<16位小写十六进制>",
  "sourceSha256": "<64位小写十六进制>",
  "title": "<清理后的标题>",
  "normalizedRedactedText": "<清理后的正文>",
  "redactionCounts": {},
  "authorizationStatus": "approved",
  "privacyReviewStatus": "approved"
}
```

AI 不应负责计算源文件 hash。管理员应使用工具计算 hash，并逐篇确认 candidate 与 source manifest 匹配。真实姓名、公开机构名称和公开地点是否保留，应按机构授权和隐私政策人工决定；联系方式、学号、证件号和凭据必须移除或替换。

建议的人工复核表：

| 检查项 | 通过标准 |
| --- | --- |
| 标题 | 保留新闻事实和结构，不含文件名、作者标记或内部编号 |
| 正文 | 段落顺序和事实含义未被 AI 改写；缺失内容没有被补写 |
| 个人信息 | 已检查姓名、联系方式、学号、证件号、账号和可组合识别信息 |
| 来源关联 | `sourceId`、源文件 hash、candidate hash 一一对应 |
| 授权状态 | source manifest 和 candidate 均为 `approved` |
| 语料用途 | 只保留结构、标题和文风参考价值，不把单篇事件事实当作长期规则 |

### 转换 DOCX 样式

如果只有 Word 样稿，可以让 AI 先输出样式调查表，再由管理员根据 Word/LibreOffice 实测填写 `document-style.json`：

```text
请从下面的文档样式说明中提取 DOCX 样式参数，不要猜测未提供的字体或字号。输出：页面尺寸、四边距、标题字体/字号/对齐/粗体/行距、正文字体/字号/对齐/首行缩进/行距/段前段后距、落款对齐、日期格式、文件命名规则和字体 family 列表。对缺失值输出 NEEDS_REVIEW，不要自行补值。
```

AI 输出的样式必须在实际 DOCX 渲染后确认。字体版本、文件 hash、供应商和许可证信息不能由 AI 生成，必须来自字体文件和授权记录。

### 生成 `training_rules.txt`

该文件是纯文本规则，不是原始新闻稿集合。可以让 AI 根据已批准的 `writing-rules.json` 生成初稿，但必须人工确认它只描述长期规则：

```text
请把下面已审核的 writing-rules.json 转成 UTF-8 training_rules.txt。
要求：每条规则单独成行；保留 hard-constraint 和 style-guidance 的含义；不要加入具体新闻事件、原始稿件标题、个人信息、文件路径、授权记录或任何要求模型突破事实边界的指令；文件末尾只保留一个换行符。
```

`training_rules.txt` 与 `writing-rules.json` 的含义必须一致。它不是第二套独立规则；如果两者冲突，应停止构建并先修订源规则。

## staging `input.json`

`input.json` 是构建器唯一的输入清单，未知字段会被拒绝。所有路径都必须是 staging 内的相对路径，且清单中的文件必须完整、无额外文件、无符号链接：

```json
{
  "format": "news-writer-private-profile-staging",
  "schemaVersion": 1,
  "profile": {
    "profileId": "profile_example-college",
    "profileVersion": "2026-08-v1",
    "supportedAppVersion": ">=0.1.0",
    "builtAt": "2026-08-13T10:00:00.000Z"
  },
  "resources": {
    "institution": "institution.json",
    "writingRules": "rules/writing-rules.json",
    "promptContract": "rules/prompt-contract.json",
    "documentStyle": "rules/document-style.json",
    "fontsManifest": "fonts/manifest.json",
    "knowledge": {
      "sourceManifest": "knowledge/source-manifest.json",
      "candidates": ["knowledge/candidates/src_0000000000000001.json"],
      "trainingRules": "knowledge/training_rules.txt"
    },
    "fonts": []
  },
  "metadata": {
    "authorizationBatchId": "authorization-batch-2026-01",
    "privacyReviewBatchId": "privacy-review-2026-01",
    "builderVersion": "private-profile-builder-v1",
    "builderSourceSha256": "<64位小写十六进制>",
    "nodeVersion": "24.18.0",
    "icuVersion": "<构建机 process.versions.icu>",
    "unicodeVersion": "<构建机 Unicode 版本>",
    "extractorVersions": { "docx": "<版本>" },
    "redactionRulesVersion": "retrieval-redaction-v1"
  },
  "approvals": {
    "privacyReviewStatus": "approved",
    "contentReviewStatus": "approved",
    "fontRedistributionStatus": "not-applicable",
    "profileLicense": "audit/profile-license.txt",
    "sourceAuthorization": "audit/source-authorization.json",
    "fontLicenseRecord": "audit/font-license-record.json"
  }
}
```

当 `resources.fonts` 非空时，路径必须形如 `fonts/<fileName>`，并且 `fonts/manifest.json` 中对应条目的 `redistributable` 必须为 `true`，`fontRedistributionStatus` 必须为 `approved`。

## 构建和验收

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm verify
corepack pnpm private:profile:build -- --staging D:\private\news-writer-staging --output D:\private\profile-output
corepack pnpm package:private-profile -- --profile D:\private\profile-output --output D:\private\news-writer-private
corepack pnpm licenses:check
```

在交付前确认：

1. profile 和便携输出位于仓库外，且互不嵌套。
2. 最终包只含固定 profile 资源和获准字体，不含原始稿、source manifest、candidate、授权/审核记录、API Key、路径或开发工具。
3. 知识库命中、零命中和资源损坏分别有清晰行为。
4. 使用 LibreOffice 或 Word 实际渲染三份代表性 DOCX，检查字体、标题、正文、落款、分页和长标题。
5. 在没有 Node.js、Python 或开发依赖的 Windows 10/11 x64 机器上打开便携目录并完成基本流程。
6. 保存 profile 版本、知识库版本、资源 hash、字体版本和验收记录，便于后续升级和回滚。

## 不应交付的内容

只交付最终便携目录。不要交付 staging、原始历史稿、候选稿、source manifest、授权/审核记录、字体安装包、构建缓存或 API Key。真实 profile、知识库和字体的授权范围独立于本仓库代码许可证。
