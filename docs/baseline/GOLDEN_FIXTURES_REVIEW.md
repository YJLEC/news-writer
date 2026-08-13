# 黄金样例 Fixture 独立门禁审查

- 状态：部分批准，按模块分批创建
- 审查日期：2026-08-09
- 审查对象：`FUNCTION_MATRIX.md`、`GOLDEN_FIXTURES_PLAN.md`
- 审查边界：只评审 fixture；本记录不创建 fixture、Schema 或测试代码

## 结论

合成 fixture 是必要的。原 `news` 中的活动纪要、稿件、检索正文、Office 文件和索引包含真实活动信息、第三方文本或开发机路径，不能直接进入 `news_writer`；同时，新产品主动改变了版本、批注、错误和导出语义，旧输出也不能作为逐字兼容基准。

批准先创建不依赖持久化形状的合成文本输入和目标 Prompt 合约。项目历史 JSON、任务快照、检索 JSONL/索引、AI 协议响应以及 DOCX 结构/渲染黄金必须等待相应 Schema 或模块门禁，不能由 fixture 反向决定尚未评审的接口。

`GOLDEN_FIXTURES_PLAN.md` 第 11 节存在阶段依赖冲突：它把 `template-spec.json`、首套 DOCX 生成/渲染以及“所有黄金测试可运行”列为阶段 1 完成证据，但 `IMPLEMENTATION_PLAN.md` 将 DOCX 设计和实现安排在阶段 7。阶段 1 不应依赖阶段 7 才能退出。建议主 agent 将这些项目改为模块级门禁：阶段 1 只批准样例设计、Schema 无关的合成输入、Prompt 合约和隐私检查；检索、项目、AI、DOCX 的可执行黄金测试分别在对应模块退出时完成。

## 最小集合

当前规划的场景覆盖充分，但文件数量可以收敛。一个输入可服务多个测试，不应为每条断言复制近似内容。

### 阶段 2 Schema 前批准创建

| ID | 建议路径 | 用途 | 批准条件 |
| --- | --- | --- | --- |
| GF-01 | `tests/fixtures/minutes/gf-01-official-complete.md` | 完整学院稿、事实提示、基础生成 Prompt | 全合成；固定 2099 年日期；无自然人姓名。 |
| GF-02 | `tests/fixtures/minutes/gf-02-official-external-organizer.md` | 外部主办、学院参与、主体不可偷换 | 与 GF-01 不重复大段活动文本。 |
| GF-03 | `tests/fixtures/minutes/gf-03-official-missing-location.md` | 缺项、补充与审稿约束 | 只缺地点，其他必填事实明确，避免多因子歧义。 |
| GF-04 | `tests/fixtures/minutes/gf-04-other-channel-material-priority.md` | other 主体、公众号渠道、辅助材料优先级 | 合并原 `other-channel-complete` 和 `other-material-priority`，减少重复。 |
| GF-06 | `tests/fixtures/retrieval/no-match-query.txt` | 合法无命中查询 | 使用合成罕见主题；不得使用空字符串同时承担无命中语义。空查询另作参数化单测。 |
| GF-07-source | `tests/fixtures/retrieval/documents/r01-*.md` 至 `r05-*.md` | 迷你检索源文本 | 只批准 5 篇独立合成 Markdown；暂不序列化为 corpus/index。 |
| GF-13-source | `tests/fixtures/text/*.input.txt` 与 `*.expected.txt` | 换行、空白、HTML 实体和中文标点规范化 | UTF-8、LF；控制字符和 NUL 在测试运行时构造，不把 NUL 写入仓库文件。 |
| GD-source | `tests/fixtures/documents/source/single-page.md`、`multi-page.md`、`long-title.md` | 未来 DOCX 的纯文本内容来源 | 此时仅作为合成正文素材，不宣称是可执行 DOCX 黄金。 |
| Manifest | `tests/fixtures/MANIFEST.md` | fixture ID、目的、来源、合成状态和人工复核记录 | 使用 Markdown，不提前发明项目或测试元数据 Schema。 |

Prompt 黄金可在 Schema 前创建，但有一道前置条件：主 agent 必须先批准独立的目标 Prompt 合约，明确章节、事实边界、检索片段角色、缺项规则及续改时批注的文本表达。之后才可建立以下少量期望文本：

- `tests/golden/prompts/gf-01-generation.txt`
- `tests/golden/prompts/gf-04-other-generation.txt`
- `tests/golden/prompts/gf-03-review-with-supplement.txt`
- `tests/golden/prompts/gf-09-revision-with-comments.txt`

这些文件只描述最终发送的文本，不包含任务/版本 JSON，不需要 `taskId`、`versionId` 或 `createdAt`。生成与 other 场景共享的章节不要各自复制为更多 fixture。

### 阶段 2 Schema 后批准创建

以下文件的字段和关系本身就是待设计的持久化契约，必须等待项目、版本、批注、任务、配置和错误 Schema 获批：

- `tests/fixtures/project/linear-history.json`
- `tests/fixtures/project/branched-history.json`
- `tests/fixtures/project/comments-by-version.json`
- 任务状态、配置覆盖、Prompt 引用和成功版本事务的 JSON fixture
- Schema 化 retrieval report、export record 和迁移前项目快照

创建时必须直接通过正式 Zod Schema 解析，并为每种不变量增加一个最小反例。不得先创建“看起来合理”的 JSON，再迫使 Schema 兼容它。

阶段 2 的项目最小集合应为：一个线性项目、一个分支项目、一个可迁移旧 Schema 项目、一个损坏项目。`comments-by-version` 若已完整包含于分支项目，可改为测试内构造，不再保留独立大 fixture。

### retrieval 模块审查后批准创建

以下内容依赖分词器、BM25、索引版本和报告 Schema，当前暂缓：

- `tests/fixtures/knowledge/mini-corpus.jsonl`
- `tests/fixtures/knowledge/mini-index-input.json`
- token 列表、BM25 分数、top-k 顺序和 retrieval report 黄金文件
- `resources/knowledge/index.json` 的任何缩小副本

retrieval 模块先选择纯 JS/WASM 分词方案、定义规范化顺序、稳定 tie-break、分数精度和索引 Schema，再把已批准的 5 篇合成 Markdown 编译为 corpus/index fixture。`mini-index-input.json` 若只是 corpus 的第二种表达，应删除，避免双重事实源；黄金索引应始终由唯一合成源生成。

无命中必须拆成两个测试：空查询验证输入边界，合成罕见查询验证合法查询无命中。两者不能共用一个 fixture 并模糊语义。

### AI 模块审查后批准创建

以下内容依赖 DeepSeek/OpenAI-compatible wire contract、transport 抽象和错误模型，当前暂缓：

- `tests/fixtures/ai/success-generation.json`
- `success-review.json`、`success-revision.json`
- `empty-content.json`、`malformed-response.json`、`http-error-redacted.json`

成功响应的 wire shape 可在 AI 模块审查后使用全合成文本固化。HTTP 延迟、取消、连接中断和超时是 transport 行为，不应伪装为 `delayed-response.json` 静态数据；应由可控的本地 mock transport/HTTP server 驱动。Header 只在测试进程内构造，fixture 不保存 `Authorization`、Bearer 值或类似真实 Key 的字符串。

### documents 模块审查后批准创建

以下内容当前暂缓：

- `tests/golden/documents/template-spec.json`
- `structural-expectations.json`
- 任何 `.docx`、PDF、PNG 或像素/感知差异基准
- `renders-word/`、`renders-libreoffice/` 下的结果

先完成 documents 模块独立选型及产品排版确认，再定义正式模板 token 和结构断言。三份已批准的纯文本素材可以提前准备，但不能让 Markdown 的临时分段方式决定未来导出 DTO。Word 是 Windows 首版的视觉权威；LibreOffice 只做跨渲染器回归，不得用它替代 Word 签核。渲染黄金还必须记录 Word/LibreOffice 版本、字体文件版本、页面尺寸和渲染环境。

## 目录与命名规则

维持 `tests/fixtures` 表示测试输入、`tests/golden` 表示经批准的确定性期望输出。不要把可变运行结果写回这两个目录。

```text
tests/
  fixtures/
    MANIFEST.md
    minutes/
    text/
    retrieval/
      documents/
    ai/                 # AI 模块批准后创建
    project/            # Schema 批准后创建
    documents/
      source/
  golden/
    prompts/            # Prompt 合约批准后创建
    facts/              # fact-hint 接口批准后创建
    retrieval/          # retrieval 模块批准后创建
    projects/           # Schema 批准后创建
    documents/          # documents 模块批准后创建
```

命名规则：

1. 文件和目录使用小写 kebab-case；测试场景以稳定 `gf-XX` 开头，算法内部样本使用模块前缀如 `r01`。
2. `gf-XX` 是需求追踪 ID，不是项目实体 ID，也不得写入产品 Schema。
3. 输入与期望成对时使用同一 stem 加 `.input.*` / `.expected.*`，不用 `final`、`new`、`latest`、`v2` 等含混名称。
4. 运行生成结果写入测试临时目录；失败测试后也不得污染 `tests/golden`。
5. golden 更新必须通过显式命令和人工 diff 审批，测试运行不得自动接受新快照。

`MANIFEST.md` 至少记录 fixture ID、关联矩阵编号、目的、是否全合成、允许出现的固定机构名、人工隐私复核日期和审查人。此信息不放进待测正文，避免污染 Prompt 和导出结果。

## 动态字段规范化

首选依赖注入，而不是生成后正则清洗：

- `Clock` 注入固定 RFC 3339 时间，例如 `2099-01-02T03:04:05.6789012Z`。
- `IdGenerator` 返回固定但格式有效的 UUID；不同实体使用不同值，避免掩盖串错引用。
- 项目根目录由临时目录注入，磁盘记录只断言相对逻辑引用；不得把临时绝对路径写入 golden。
- 随机数、排序 locale、时区和换行符均显式固定；文本统一 UTF-8、LF 和单一末尾换行。

只有无法注入的外部字段才允许在比较器中规范化，并且必须按已批准 JSON Pointer 白名单逐字段替换。禁止对整个字符串全局替换日期、UUID、数字或路径，因为这会掩盖新闻正文事实、错误引用和路径泄漏。

建议占位符只用于人工可读 Prompt/诊断黄金，如 `{{KNOWLEDGE_VERSION}}`。Schema fixture 应保存格式有效的确定值，不应填 `{{TASK_ID}}` 这类无法通过正式 Schema 的文本。

BM25 分数规范化必须等待 retrieval 决策。原则上断言文档 ID 顺序和经明确位数舍入的分数；对相同分数另断言稳定次级排序，不比较整个索引文件字节。DOCX 的时间、作者、应用版本等属性应由导出器显式固定或删除，而不是事后从二进制中搜索替换。

## 断言强度

| 对象 | 必须精确断言 | 不应采用的断言 |
| --- | --- | --- |
| 文本规范化 | 完整输出字符串、LF、末尾换行 | 只断言包含几个词。 |
| 事实提示 | 字段、缺项集合、来源片段、确定顺序 | 对整个自然语言提示做脆弱快照。 |
| Prompt | 章节顺序、最终全文、安全关键句、实际传输文本 | 仅做 snapshot 无语义负面断言。 |
| 领域状态 | 完整版本树、latest、父子关系、批注归属、前后哈希 | 只看版本数量或显示名。 |
| AI wire 解析 | 输入 payload 到解析结果的完整映射 | 对非确定的真实模型措辞做黄金比较。 |
| 错误 | 稳定错误码、终态、无版本副作用、脱敏 | 把本地化用户消息或完整服务端 body 当稳定 API。 |
| retrieval | top-k ID、稳定 tie-break、批准精度的分数、无路径 | 整个索引 JSON 字节级比较。 |
| DOCX | 结构、正文、样式 token、负面内容、全页渲染 | 只验证 ZIP 可开或单张局部截图。 |

每个成功场景至少有一条能证明测试会失败的对应反例。特别是版本事务必须断言“失败后旧版本内容哈希和 `latestVersionId` 均不变”，不能只断言没有返回新 ID。

Prompt 黄金同时需要结构化语义断言，至少检查：纪要/补充才是事实来源、旧稿仅供风格参考、other 不自动套用学院主体、缺项不得编造、修订只包含父版本届时批注。单纯整文件 snapshot 容易在批量更新时把错误一起批准。

## 隐私与第三方文本边界

### 允许

- 产品所需的固定机构名“示例学院”及通用部门/角色称谓。
- 已确认的事实性格式规范，如字体名称、字号、段落对齐和 BM25 参数。
- 过短且功能性的 Prompt 章节名，如“写作规范”“输出要求”。
- 完全重新创作的 2099 年虚构活动、无自然人姓名的稿件和检索语料。
- 经逐条复核并重新表述的 14 条规则卡；应记录规则来源，不复制培训 PPT 长段原文。

### 禁止

- 原活动纪要、输出稿、检索摘录、corpus/index 记录的整段复制或轻微同义改写。
- 培训 PPT 原文页、历史稿正文、第三方新闻稿、照片/OCR、Office/PDF/PPTX/ZIP 二进制。
- 真实人员、联系方式、班级/学号、可定位事件组合、源文件元数据和绝对路径。
- 服务端完整错误 body、认证 Header、API Key 片段或“看起来像 Key”的示例。

`.invalid` 邮箱虽然不可投递，仍会被通用邮箱扫描命中；应在扫描规则中建立精确 allowlist，不能因此关闭邮箱扫描。手机号、身份证号、学号、微信号和 secret 哨兵在测试运行时分片拼接，源文件和 snapshot 均不得保存完整值。

提交前必须执行自动扫描和独立人工复核。建议对禁止来源做连续长句检查：对 16 个及以上连续中文字符的匹配逐项复核，排除批准的机构名和规范短语；该阈值只能用于发现问题，不能替代人工判断或被视为法律上的“安全线”。

所有 fixture 均应在 `MANIFEST.md` 标记 `synthetic: yes` 和来源说明。未来若确需使用第三方或真实内部文本，必须单独记录授权、用途、保留期限和再分发范围，不能沿用本次批准。

## 批准与暂缓清单

### 批准

- 4 份最小合成纪要：GF-01 至 GF-04。
- 5 篇 retrieval 合成源 Markdown 和 1 个合法无命中查询文本；只批准原始文本，不批准 JSONL/index。
- 文本规范化输入/期望文本；高风险字符在运行时构造。
- 3 份未来 DOCX 使用的纯文本素材；当前不作为 DOCX 黄金。
- `tests/fixtures/MANIFEST.md`。
- 目标 Prompt 合约经主 agent 单独批准后，4 份确定性 Prompt 黄金文本。

### 暂缓

- 所有项目、版本、批注、任务、配置、检索报告和导出记录 JSON，等待阶段 2 Schema。
- `mini-corpus.jsonl`、索引、tokens、分数和检索报告黄金，等待 retrieval 模块。
- AI JSON 响应和错误 fixture，等待 AI 客户端/错误模型审查；延迟与取消改用 mock transport，不创建静态延迟 fixture。
- `template-spec.json`、DOCX、结构期望、PDF/PNG 和渲染目录，等待 documents 模块审查及排版批准。
- 任何真实或经轻量脱敏的原项目内容、二进制文件、绝对路径和密钥形态文本，永久禁止。

## 对 coding agent 的准入意见

批准 coding agent 在主 agent 确认上述目录和 Prompt 合约后，创建“批准”清单中的最小合成文本与 `MANIFEST.md`。本次批准不授权创建 JSON 项目状态、检索索引、AI 响应、DOCX 或相关代码。

fixture 创建后必须由另一名独立 review agent 检查：

1. 与功能矩阵 ID 双向可追踪。
2. 没有从 `news` 复制长句、真实活动事实或二进制内容。
3. 自动敏感模式、绝对路径、UTF-8/NUL/U+FFFD 扫描通过。
4. 每个文件确实服务已批准断言，没有重复或无消费者的样例。
5. Prompt 黄金同时有语义断言计划，不依赖盲目 snapshot 更新。

通过该 review 只证明阶段 1 的 Schema 无关 fixture 就绪；不代表 retrieval、AI、project 或 documents 的黄金基准已经获批。
