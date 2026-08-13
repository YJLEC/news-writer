# 实施计划

本计划受 `GOAL.md` 约束。任何实现偏离目标、架构或范围时，必须先更新决策并获得确认，不得由 coding agent 自行扩大范围。

## 通用门禁

每个阶段和新模块按以下顺序推进：

1. 独立审查 agent 检查必要性、现有模块复用空间和成熟开源方案。
2. 主 agent 固化模块边界、接口、依赖、风险和验收条件。
3. coding agent 编写实现及对应测试。
4. 独立 review agent 审查行为、安全、测试和重复实现。
5. 主 agent 完成跨模块集成和阶段验收。

未通过当前阶段退出条件，不进入依赖它的后续阶段。

## 阶段 0：规格和工程决策基线

工作内容：

- 将 Electron 安全模型、纯 TypeScript、只读知识库、项目可移植性和 Windows 交付范围记录为架构决策。
- 评审并锁定 Electron、Node.js、React、TypeScript、Monaco、测试框架、构建工具和包管理器。
- 定义依赖准入、版本锁定、许可证检查和原生扩展例外审批规则。
- 把首版功能和明确非目标转换为可追踪验收清单。

退出条件：工程选型经过独立 agent 审查，模块边界和验收口径无未决冲突。

## 阶段 1：功能矩阵和黄金样例

工作内容：

- 只读提取 `news` 的生成、审稿、续改、检索、脱敏、事实检查、命名和 DOCX 行为。
- 建立原行为、目标行为、保留差异、测试依据四列功能矩阵。
- 建立学院稿、其他稿、缺失信息、无检索结果、续改、分支和异常响应样例。
- 固化 Prompt 结构、培训规则、机构称谓规则、检索结果和 DOCX 视觉基准。
- 所有进入仓库的 fixture 必须确认不含 API Key 和不必要的个人信息。

退出条件：黄金测试能够描述目标行为，不需要执行原 Python 实现作为运行时依赖。

## 阶段 2：Schema、领域层和项目存储

工作内容：

- 定义带版本号的项目、版本、批注、Prompt、任务、检索、导出和配置 Schema。
- 通过共享运行时 Schema 校验磁盘数据、IPC 数据和配置覆盖结果。
- 实现版本树、最新版切换、分支、不可变版本和归档等纯领域规则。
- 实现批注跟随版本、仅最新版可编辑、生成时快照和导出忽略批注的规则。
- 实现任务状态机以及“只有成功且非空的任务才能创建版本”的事务边界。
- 实现项目创建、打开、校验、迁移、追加写入、原子更新和崩溃恢复。

退出条件：在不启动 Electron 的条件下，通过单元测试验证所有状态转换和项目复制恢复。

## 阶段 3：内置知识库和检索

工作内容：

- 编写仅在构建阶段使用的 TypeScript 语料生成工具，不在 App 中提供入口。
- 从原项目自带学院稿生成清理、脱敏后的规范化语料。
- 实现中文分词、BM25 索引和检索报告。
- 生成 `corpus.jsonl`、`index.json`、`training_rules.txt` 和 `metadata.json`。
- App 运行时以只读方式加载并校验知识库资源。
- 保存每次检索实际进入 Prompt 的文本、命中 ID、分数和知识库版本。

退出条件：固定查询结果稳定，便携资源中不存在原始 Office、PDF、PPTX 或图片。

## 阶段 4：DeepSeek 客户端和任务执行

工作内容：

- 实现内部 OpenAI-compatible 边界和首版 DeepSeek 适配。
- 实现非流式请求、超时、取消、响应校验和安全错误映射。
- 通过 Worker Thread 或 `utilityProcess` 执行耗时任务，不阻塞 renderer 或主进程。
- 任务仅展示 queued、preparing、requesting、processing、saving、succeeded、failed、cancelled、timedOut 等当前状态。
- 把实际 Prompt、模型、推理强度、时间和结果与任务记录关联。
- 验证取消提示不会承诺服务端停止或不计费。

退出条件：错误、超时、取消和空响应均不会覆盖版本或创建成功版本。

## 阶段 5：Electron 主进程、preload 和安全 IPC

工作内容：

- 主进程负责窗口、项目文件、凭据、任务进程、导出和只读资源访问。
- preload 只暴露按业务用途拆分的最小 API，不暴露通用 Node 或 IPC 能力。
- renderer 启用 `contextIsolation`，关闭 `nodeIntegration`，限制导航并配置 CSP。
- 所有 IPC 双向数据经过共享 Schema 校验，并校验路径和项目归属。
- 使用 `safeStorage`/DPAPI 保存用户认证，日志统一脱敏。
- 增加 renderer 注入、越权路径、伪造 IPC 和凭据泄露测试。

退出条件：renderer 无法直接访问任意文件、Node API 或明文凭据。

## 阶段 6：Monaco 工作区和完整交互

工作内容：

- 实现顶部菜单、默认折叠资源树、Monaco 双栏和默认开启的批注区。
- 实现纪要和 Prompt 编辑、最新版展示、历史稿浏览和 diff。
- 显示当前最新版、有效父子链、分支来源和其他历史分支。
- 实现历史版本设为最新版，并恢复该版本已有批注的查看和编辑能力。
- 实现稳定文本锚点、锚点失效提示和批注编辑。
- 实现首次 Prompt 编辑警告和配置覆盖来源展示。
- 接通新建、打开、归档、生成、审稿、续改、取消和错误恢复流程。

退出条件：使用模拟 AI 的端到端测试可以完成全部日常流程及版本分支操作。

## 阶段 7：DOCX 样板和导出

工作内容：

- 固化标题、正文、落款、日期、字体、字号、缩进、对齐和段落间距规范。
- 独立评审成熟纯 JavaScript DOCX 方案，原则上不手写 OOXML。
- 导出只读取用户指定版本的正文，忽略该版本的批注及全部内部数据。
- 建立 DOCX 结构、文本、样式和黄金文件测试。
- 在构建或验收环境使用 Word 或 LibreOffice 实际渲染成 PDF/图片并视觉检查。

退出条件：文件内容干净，实际渲染的排版与样板一致。

## 阶段 8：集成、异常和安全验收

工作内容：

- 验证完整操作流程和学院稿、其他稿的规则隔离。
- 验证网络中断、超时、取消、重复点击、窗口关闭和应用崩溃恢复。
- 验证认证失效、知识库损坏、项目损坏、磁盘写满、不可写目录和中文长路径。
- 验证项目复制后内容完整且不携带认证信息。
- 使用 Playwright 驱动 Electron 进行关键流程、桌面尺寸和较小窗口视觉检查。

退出条件：功能矩阵全部通过，无阻断级安全、数据完整性或可用性问题。

## 阶段 9：Windows 便携打包和最终验收

工作内容：

- 生成 Windows 10/11 x64 完整便携目录。
- 写入应用、Electron、Chromium、项目 Schema 和知识库版本诊断信息。
- 检查产物不包含源码凭据、原始知识库文件、Python 或开发机绝对路径。
- 在无 Node.js、Python、conda 和独立浏览器的 Windows 环境执行完整流程。
- 验证目录复制、真实 DeepSeek 请求、取消、异常恢复、项目跨路径打开和 DOCX 渲染。
- 记录未签名程序的 SmartScreen 风险；是否签名在交付阶段单独决定。

退出条件：便携目录脱离源码和开发环境后仍可完成首版全部验收流程。

## 首个实施批次

正式开工后只启动阶段 0 和阶段 1：

1. 独立 agent 审查工程选型和测试工具，避免过早引入框架或重复依赖。
2. coding agent 仅建立经过批准的最小工程骨架和测试入口。
3. 另一组 agent 只读建立 `news` 功能矩阵与脱敏黄金样例。
4. 主 agent 校验两条工作流的接口需求，阶段 1 通过后再启动 Schema 和领域层。

不得在功能矩阵、黄金样例和 Schema 就绪前直接实现完整 GUI 或真实 AI 工作流。

## 阶段 10：机构配置包与专属 App 本地化

本阶段在首版主体流程完成后执行，用于让管理员离线构建不同机构的专属 App。普通用户不接触配置包，也不能切换机构或管理知识库。

### 10.0 审查与边界

- 独立 review agent 审查配置包的必要性、现有 retrieval/project/domain/documents 能力复用、成熟开源方案和许可证边界。
- 新增纯 TypeScript `packages/institution`，不引入 Python、sidecar、原生扩展或运行时配置编辑器。
- `packages/domain` 只接收经过 Schema 校验的不可变 `WritingProfileSnapshot`，不读取文件系统。
- 机构配置、真实语料、字体和审核材料从公开仓库之外的 staging 目录注入。

### 10.1 Schema、builder 和 synthetic profile

- 定义 `manifest.json`、`institution.json`、`writing-rules.json`、`prompt-contract.json`、`document-style.json` 和字体 manifest Schema。
- 使用固定资源白名单、相对路径、sha256/byteLength 和严格 metadata 校验。
- 公开仓库提供 `synthetic-public-fixture` profile；正式构建强制标记 `approved-private-profile`，不得把真实资源混入公开 bundle。
- 复用 `@news-writer/retrieval` bundle validator/loader；知识库仍为只读四文件资源。
- 提供私有 staging 构建命令和授权/字体许可证模板，不把 staging 路径写入产物。

### 10.2 Domain、project 和任务追踪

- 将系统安全硬约束与机构可替换写作规则分离。
- Prompt preparation 接收 profile snapshot，并把 profile、规则、Prompt contract、知识库、文档样式版本及资源 hash 写入 Prompt/任务/版本追踪。
- 项目保存创建/使用时的 profile 版本；相同 profile 可复制恢复，不同 profile 默认禁止生成和修改。
- 保留 `prompt-contract-v1` 的迁移兼容读取，但新生成使用配置包版本。

### 10.3 Electron、DOCX 和打包

- 主进程在启动时从 `resources/institution` 结构化加载唯一 profile；缺失、额外文件、hash、Schema 或字体清单错误时返回 `PROFILE_RESOURCE_INVALID`/`RESOURCE_UNAVAILABLE`，不崩溃、不回退、不联网。
- Renderer 只通过现有受控 IPC 获得 profile view，不增加配置管理 IPC 或机构选择器。
- documents builder 使用 profile 的 document-style token；字体文件仅在 manifest 明确允许再分发时进入私有包。
- electron-builder/package smoke 仅允许 institution manifest、规则、知识库四文件和已授权字体进入包。

### 10.4 验收

- 覆盖 synthetic/private-style profile、资源篡改/缺失/多余文件、规则 Schema、系统硬约束不可关闭、版本追踪、项目复制和 profile mismatch。
- 在干净 Windows 10/11 x64 环境生成并渲染 DOCX，验收字体、标题、正文、落款和分页。
- 运行 `verify`、E2E、package smoke、licenses 门禁，并由独立 review agent 最终复审。
