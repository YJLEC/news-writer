# 黄金样例与测试 Fixture 规划

## 1. 文档状态

- 阶段：实施计划阶段 1，只定义样例和断言，不创建实际 fixture。
- 原项目：`<legacy-news-root>` 仅作只读行为基准。
- 目标项目：所有后续 fixture 只能写入 `<repo-root>\tests`。
- 基准优先级：`GOAL.md` 和已确认产品规则高于旧实现。旧实现中的缺陷不得因“兼容”进入黄金断言。
- 隐私结论：现有 `inputs`、`inputs_other`、`outputs`、`outputs_other`、`data/corpus.jsonl`、`data/index.json` 均不得直接复制为测试 fixture。

## 2. 已检查证据

只读检查范围：

- `inputs/20260617.txt`：学院稿完整纪要场景。
- `inputs_other/20260806.txt`：其他新闻稿、公众号渠道、材料取舍场景。
- `outputs/20260617/`：生成、检索、初稿、审稿和 DOCX 完整链路。
- `outputs_other/20260806/`：生成、审稿、人工意见、续改及历史版本链路。
- `data/training_rules.txt`：14 条规则卡和培训 PPT 重点页摘录。
- `data/corpus.jsonl`：87 条记录，其中 69 条新闻稿、1 条培训材料、17 条培训页记录；全部带开发机绝对路径。
- `data/index.json`：69 条 BM25 文档；每条包含绝对路径、大段正文和 token 计数。
- `scripts/news_common.py`：清理、脱敏、分词、BM25、事实提示、场景规则、三类 Prompt、AI 调用、DOCX、标题和文件名处理。
- `scripts/generate_news.py`、`review_news.py`、`revise_news.py`：生成、二次审稿和续改编排。

关键行为定位：

| 行为 | 旧实现证据 |
| --- | --- |
| 培训规则卡 | `scripts/news_common.py:233` |
| 分词与 BM25 | `scripts/news_common.py:265`、`:290`、`:335` |
| official/other 场景差异 | `scripts/news_common.py:376` |
| 日期、时间、地点和缺项提示 | `scripts/news_common.py:415` |
| 生成 Prompt | `scripts/news_common.py:480` |
| 审稿 Prompt | `scripts/news_common.py:533` |
| 续改 Prompt | `scripts/news_common.py:590` |
| DeepSeek 非流式请求 | `scripts/news_common.py:643` |
| Markdown 正文拆分 | `scripts/news_common.py:742` |
| DOCX 输出 | `scripts/news_common.py:759` |
| 标题、日期和文件名 | `scripts/news_common.py:836`、`:943` |
| 最终正文清理 | `scripts/news_common.py:949` |
| 旧版续改选择和归档 | `scripts/revise_news.py:33`、`:49`、`:93` |

## 3. 复用分级

### 3.1 可在人工复核后复用

以下内容不含活动事实，可作为目标规范的文本来源，但仍需在进入仓库前逐行复核：

- `data/training_rules.txt` 前 14 条精简规则。
- Prompt 的通用章节名称，例如“写作规范”“场景设置”“新活动纪要”“自动事实检查提示”“输出要求”。
- official/other 的主体、称谓和事实来源边界。
- 生成稿只输出“标题 + 正文 + 落款”、审稿稿不得输出问题清单等通用约束。
- BM25 参数和计算方式可作为算法对照，不作为必须逐字移植的实现。

`training_rules.txt` 的 PPT 原文摘录不能整段直接复用，其中含真实人员姓名和旧工作流的送审细节。后续资源构建时应以经过审查的规则卡为主，原文摘录需单独做必要性和隐私审查。

### 3.2 仅作行为参考，必须全合成

- 两份活动纪要及由其产生的全部 Prompt、初稿、终稿、审稿意见和续改稿。
- 两份检索报告及其召回正文。
- `corpus.jsonl`、`index.json` 的所有记录内容。
- 两份 DOCX 成稿的正文、文件名、文档属性和二进制内容。
- 所有图片、压缩包和原始 Office 文件。

合成样例只保留以下行为特征：

- official 场景中“外部单位主办、学院参与”的叙事角度。
- other 场景中 `[主体]`、`[活动内容]`、`[其余信息]`、`[新闻稿要求]` 对发布主体、渠道和语气的影响。
- 纪要完整、纪要缺项、无检索命中、补充信息、二次审稿和按批注续改。
- 历史版本切换、从历史版本分支、批注永久跟随对应版本。

### 3.3 明确禁止进入仓库

- 真实姓名、手机号、身份证号、学号、邮箱、微信号、班级名单或可识别个人的自由文本。
- 原项目绝对路径、用户名、开发机目录、压缩包内部路径。
- API Key、Bearer Header、`.env` 内容或任何看似真实的 Key。
- 真实活动照片、图片 OCR 文本、原 DOC/DOCX/PDF/PPTX/ZIP。
- 可通过“日期 + 地点 + 姓名 + 组织”组合定位个人的细粒度事实。

## 4. 建议目录和清单

以下为计划中的目标路径，本阶段不创建这些文件：

```text
tests/
  fixtures/
    minutes/
      official-complete.md
      official-missing-location.md
      official-external-organizer.md
      other-channel-complete.md
      other-material-priority.md
      privacy-runtime-cases.json
    knowledge/
      mini-corpus.jsonl
      mini-index-input.json
      no-match-query.txt
    ai/
      success-generation.json
      success-review.json
      success-revision.json
      empty-content.json
      malformed-response.json
      http-error-redacted.json
      delayed-response.json
    project/
      linear-history.json
      branched-history.json
      comments-by-version.json
    documents/
      clean-news.md
      multi-page-news.md
      long-title-news.md
  golden/
    facts/
    retrieval/
    prompts/
    responses/
    projects/
    documents/
      template-spec.json
      structural-expectations.json
      renders-word/
      renders-libreoffice/
```

## 5. 核心场景与预期断言

### GF-01 学院稿：信息完整

合成纪要使用固定的未来日期、通用教室、虚构活动和角色称谓，不使用自然人姓名。

预期断言：

- 识别日期、时间、具体地点和组织主体，`missing` 为空。
- official 发布和落款主体为“示例学院”。
- Prompt 明确旧稿仅用于风格，不得作为新活动事实来源。
- 生成 Prompt 章节顺序稳定，实际发送 Prompt 可完整保存并关联任务。
- 成功且非空响应才可产生版本。

### GF-02 学院稿：外部单位主办

预期断言：

- 不把活动改写为学院主办或承办。
- 叙事角度体现“学院师生参加”。
- 外部单位信息只来自纪要。
- 未提供人员姓名时不得补写姓名。

### GF-03 学院稿：缺少地点

预期断言：

- 事实提示准确包含“具体地点”，不误报已提供的日期和主体。
- 生成 Prompt 允许先列需补充信息；不得用括号占位符伪造地点。
- 用户补充地点后，审稿 Prompt 将补充作为事实来源。
- 用户不补充时，审稿输出约束要求删除或避开地点，不保留“待补充”字样。

### GF-04 其他新闻稿：公众号渠道

预期断言：

- 从方括号小节读取主体、材料优先级、目标渠道和语气。
- 不自动写成示例学院主办、参与或落款。
- 学院专属简称规则只在纪要明确涉及学院时适用。
- 培训规则中的真实性、结构、标点和简洁要求仍生效。

### GF-05 材料取舍与主体偷换

对应旧样例中“背景通知主体被错误替换为实践队”和“辅助视频大纲被过度照抄”的审稿问题。

预期断言：

- `[活动背景]` 不能自动转化为活动主体的既成行为。
- `[其余信息]` 明确标记为辅助材料时，不得高于 `[活动内容]`。
- 批注要求减少照抄、修正主体后，修订 Prompt 包含这些批注及引用锚点。
- 修订稿不得引入纪要和当前版本都没有的新事实。

### GF-06 无检索结果

预期断言：

- 空查询或无匹配查询返回空列表，不伪造参考稿。
- Prompt 显式表示未检索到相似旧稿，仍可依据纪要生成。
- 检索记录包含知识库版本、查询摘要和空命中列表。

### GF-07 可重复检索

使用 4 至 6 篇完全合成的迷你语料，覆盖主题相近、仅地点相近、仅高频词相近和无关文档。

预期断言：

- 规范化和分词版本固定后，top-k 文档 ID 和顺序稳定。
- 相同分数使用稳定次级排序，不依赖对象遍历顺序或文件时间。
- 分数采用明确精度规范；不要对浮点二进制或整个索引 JSON 做字节级断言。
- 检索报告只保存逻辑文档 ID、标题、分数、进入 Prompt 的摘录和知识库版本，不保存绝对路径。

### GF-08 二次审稿

预期断言：

- 审稿 Prompt 包含实际初稿、原纪要和本次补充信息。
- 无补充信息时写明避开无法确认内容。
- 最终结果清理掉“审稿意见”“问题清单”“需补充信息”等内部段落。
- 清理后为空时视为失败，不回退成被清理前的内部说明文本。

### GF-09 批注续改

预期断言以 `GOAL.md` 为准，不复制旧脚本“累积所有历史意见”的方式：

- 仅 `latestVersionId` 对应版本的批注允许新增或编辑。
- 从版本生成时，快照该版本当时的全部批注及锚点、引用文本。
- 新版本不继承父版本批注。
- 再次从同一父版本生成时，使用该父版本届时保存的批注形成另一分支。
- 其他版本和历史轮次的批注不得混入本次 Prompt。

### GF-10 版本回溯与分支

预期断言：

- `latestVersionId` 可指向创建时间更早的成功版本。
- 回溯不删除后续版本；原链保留为历史分支。
- 回溯版本原有批注恢复可见、可编辑。
- 从回溯版本生成的新版本以该版本为 `parentVersionId`。
- 版本显示名可使用时间戳，但身份判断只使用不可变 ID。

### GF-11 AI 异常响应

覆盖 HTTP 错误、超时、取消、空内容、缺少 `choices`、缺少 `message.content` 和非 JSON 响应。

预期断言：

- 状态只能落入 `failed`、`cancelled` 或 `timedOut`，不得写成 `succeeded`。
- 不创建版本、不修改 `latestVersionId`、不覆盖内容文件。
- 错误模型保存安全错误码、用户可理解消息和可脱敏诊断，不保存认证 Header 或完整服务端回显。
- 取消提示说明本地停止等待，但不承诺服务端停止处理或不计费。

### GF-12 Prompt 编辑

预期断言：

- 首次编辑系统生成 Prompt 前出现一次明确警告。
- 实际发送内容等于用户确认后的最终 Prompt。
- 项目不额外保存“系统原始 Prompt”。
- 实际 Prompt、模型、推理强度和任务 ID 关联。

### GF-13 文本清理和文件名

预期断言：

- 清理 NUL、控制字符、多余空白并统一 LF，但不改变有意义的中文标点。
- 标题提取忽略“最终新闻稿”“问题清单”等包装标题。
- 导出文件名移除 Windows 禁用字符、尾部空格和尾点。
- 日期优先取明确活动日期；无法识别时由调用方显式提供，不在黄金测试中依赖当前系统时间。
- 文件名不承担版本唯一性。

## 6. 脱敏与合成规则

### 6.1 合成原则

- 所有活动、材料、人物、数字和引用均重新创作，不做同义替换式“脱敏”。
- 固定使用明显的测试日期，例如 2099 年；避免与当前真实活动相撞。
- 地点使用“教学楼 A101”“会议室 B202”等通用地点。
- 人员优先使用角色称谓，如“主讲教师”“学生代表”，不造自然人全名。
- 必须测试姓名字段时使用明确测试标签，如“测试嘉宾甲”，并在 fixture 元数据标记 `synthetic: true`。
- 必须测试手机号、身份证号、学号或微信号的正则行为时，在测试运行时由片段拼接生成；仓库不存放完整高风险号码串。
- 邮箱使用 `.invalid` 保留域。
- secret 脱敏测试由运行时注入 `TEST_SECRET_SENTINEL`，仓库中不得保存 `sk-...` 或 Bearer 值。

### 6.2 自动扫描

每个 fixture 提交前执行：

- 手机号、身份证号、学号、邮箱、微信号模式扫描。
- `DEEPSEEK_API_KEY`、`Authorization`、`Bearer` 和常见 Key 前缀扫描。
- Windows 绝对路径、UNC 路径、用户目录和开发机盘符扫描。
- Office 文档属性、批注、修订、页眉页脚、脚注、媒体和嵌入对象扫描。
- UTF-8 解码、NUL 和替换字符 `U+FFFD` 扫描。

自动扫描无法可靠识别人名和事实组合，因此还需要独立 agent 人工复核：

- 对照原材料检查是否存在连续长句复用。
- 检查自然人姓名、具体班级、组织内部人员和可定位活动组合。
- 只允许经批准的机构名称和产品必须测试的固定称谓进入 allowlist。

## 7. 黄金断言策略

不同输出使用不同强度，避免脆弱的全文件比较：

| 对象 | 断言方式 |
| --- | --- |
| 纯文本规范化 | 精确字符串，统一 LF 和末尾换行 |
| 事实提示 | 结构化对象精确比较，数组顺序有定义 |
| Prompt | 章节顺序和安全关键句精确比较；动态 ID、时间用稳定占位符 |
| BM25 | 文档 ID 顺序、top-k、分数舍入值和稳定 tie-break 比较 |
| 检索报告 | Schema + 关键字段精确比较；禁止绝对路径 |
| AI 请求 | method、URL、模型、消息、推理强度和超时契约比较；Header 只断言存在，不记录值 |
| AI 错误 | 错误码、任务终态和无版本副作用比较 |
| 项目历史 | 版本树、`latestVersionId`、父子关系和批注归属比较 |
| DOCX | 模板 token、OOXML 结构、纯文本、全页渲染和人工视觉签核组合 |

Prompt 黄金文件不得整份沿用旧 Prompt。应以目标 TypeScript Prompt builder 的批准输出为准，并明确标注旧行为差异。

## 8. DOCX 视觉基准方案

### 8.1 旧成稿观察

旧 `write_docx` 的意图为：

- 标题：方正小标宋简体、22 pt、居中。
- 正文：仿宋_GB2312、16 pt、两端对齐、首行缩进 32 pt。
- 学院落款和日期：右对齐。

对两份现有 DOCX 的只读 OOXML 检查还发现：

- 页面使用 Word 默认 Letter 尺寸，不是明确声明的 A4。
- 页边距来自默认模板，未形成正式模板 token。
- 未显式设置 1.5 倍行距和段前/段后距；与培训规则不完全一致。
- other 场景的非学院落款不会被旧逻辑识别为落款，因而可能仍按正文缩进和两端对齐。
- 文档核心属性包含生成工具作者信息。
- 文件没有批注和修订，但这是现有样例的偶然状态，不足以证明导出清洁规则。

因此现有 DOCX 只能作为缺陷发现基准，不能作为二进制或像素级目标样板。

### 8.2 正式样板 token

在 `packages/documents` 编码前由独立 agent 和产品负责人批准 `template-spec.json`，至少明确：

- 页面尺寸、方向、上下左右边距。
- 标题字体、字号、字重、对齐、行距、段前和段后。
- 正文字体、字号、两端对齐、1.5 倍行距、首行缩进 2 个中文字符、段前后 0。
- 落款和日期的字体、对齐、行距和相对顺序，且不依赖主体名称硬编码。
- 中文字体不可用时的失败提示或明确字体回退策略。
- 页眉、页脚、页码、孤行控制和分页规则。
- 文档属性清理规则。

### 8.3 三层验收

1. 结构验收
   - DOCX ZIP、关系和 content type 完整。
   - 标题、正文、落款、日期均使用批准样式。
   - 无 comments、tracked changes、隐藏文本、外部链接、嵌入对象和媒体。
   - core/custom properties 不含用户名、开发路径或工具内部信息。

2. 内容验收
   - 导出正文与指定版本一致。
   - 不含批注、Prompt、检索记录、任务信息、问题清单和占位符。
   - official 与 other 都能正确识别并排版其落款，不通过主体字符串特判。

3. 渲染验收
   - 使用固定字体集在 Windows Word 渲染，作为首版权威视觉基准。
   - 使用 LibreOffice 渲染作为自动化回归的第二基准，不要求与 Word 逐像素相同。
   - 每次导出相关修改后将 DOCX 渲染为 PDF/PNG，逐页检查标题换行、字体替换、段落缩进、行距、落款、分页、缺字、重叠和裁切。
   - 自动比较页数、页面尺寸和感知差异；像素差异超阈值时必须人工复核，不能仅靠阈值自动批准。

计划建立三份合成文档黄金输入：普通单页、跨页长稿、超长标题。必要时再增加中英文混排和 other 落款样例。

## 9. 不应固化的旧行为

- 不保存检索源的绝对路径。
- 不把历史稿全文无上限写入检索记录或 Prompt。
- 不依赖文件名、修改时间或重命名判断最新版。
- 不累积并发送其他版本的历史审稿意见；只使用本次父版本的批注快照。
- 不通过捕获所有异常后静默生成简化 DOCX。
- 不在清理结果为空时回退到包含问题清单的原始 AI 输出。
- 不对“海南校区”等词做脱离语境的全局替换。
- 不将 API 服务端原始错误体直接写入用户项目或日志。

## 10. 创建 fixture 前的门禁

1. 独立审查 agent 批准 fixture 必要性、合成程度和第三方文本复用边界。
2. 主 agent 批准 Schema、文件命名、动态字段规范化和断言方式。
3. coding agent 创建最小 fixture 与测试，不复制原项目素材。
4. 独立 review agent 执行隐私扫描、长句相似性检查和测试有效性检查。
5. DOCX 样板必须完成全页渲染和人工视觉签核后，才能成为黄金基准。

## 11. 阶段 1 完成证据

阶段 1 只以 Schema 无关的样例设计和纯文本输入为退出范围：

- 功能矩阵与 fixture ID 建立双向映射。
- 独立 fixture 审查记录必要性、复用边界、批准和暂缓清单。
- 审查批准的最小合成纪要、retrieval 原始 Markdown、合法无命中查询、文本规范化样例、未来 DOCX 纯文本素材和 `MANIFEST.md` 已创建。
- 所有已创建 fixture 通过 UTF-8、NUL、`U+FFFD`、敏感模式、绝对路径和原项目长句复用检查。
- 目标 Prompt 合约必须由主 agent 单独批准；合约未批准前不得创建 Prompt 黄金文本。该事项作为 Prompt fixture 的前置门禁记录，不用临时快照替代。

以下证据改由相应模块负责，不阻塞阶段 1 的 Schema 无关 fixture 退出：

- 阶段 2 Schema 门禁：项目、版本、批注、任务、配置、检索报告和导出记录 JSON fixture 直接通过正式 Schema 校验。
- retrieval 模块门禁：分词、BM25、稳定排序和分数精度获批后，由唯一的合成 Markdown 源生成 corpus/index 及检索黄金。
- AI 模块门禁：wire contract、transport 抽象和错误模型获批后创建 AI 响应 fixture；超时和取消使用可控 transport 测试。
- documents 模块门禁：排版规范和库选型获批后创建 `template-spec`、结构断言和 DOCX，并完成 Word 权威渲染及 LibreOffice 回归检查。
- 集成验收门禁：全部黄金测试可在不执行 `news` Python/PowerShell 的情况下运行。
