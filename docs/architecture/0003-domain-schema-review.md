# 0003 领域与项目 Schema 编码前独立审查

- 状态：有条件批准阶段 2 编码
- 审查日期：2026-08-09
- 审查角色：独立 domain/schema review agent
- 依据：`AGENTS.md`、`GOAL.md`、`IMPLEMENTATION_PLAN.md`、`FUNCTION_MATRIX.md`、`GOLDEN_FIXTURES_PLAN.md`、`GOLDEN_FIXTURES_REVIEW.md`、`0004-project-storage-review.md`
- 范围：项目、版本、批注、实际 Prompt、AI 任务、检索记录、导出记录、非敏感配置、安全错误、磁盘格式、迁移和纯领域规则
- 不在范围：真实 AI wire、检索算法/知识库格式、DOCX 实现、Electron IPC handler、GUI 和任何 fixture

## 结论

阶段 2 的 Schema 和纯领域层是必要模块，不能继续依赖文件名、mtime、renderer 临时状态或后续 AI/DOCX 模块反向定义。当前 `packages/domain`、`project`、`shared` 只有骨架占位符，没有可复用业务实现；应在现有 package 边界内实现，不新增顶层 package。

批准 coding agent 在本文限定范围内实现：

1. `packages/shared` 的 ID、时间、内容引用、配置值、安全错误等最小跨边界值 Schema。
2. `packages/domain` 的项目聚合类型、纯状态转换、版本树、批注、任务状态机和配置解析。
3. `packages/project` 的磁盘 V1 Schema、交叉引用校验、内容文件读写、成功版本事务、原子替换、恢复和迁移框架。
4. 与这些能力直接对应的单元、项目存储集成测试，以及 Schema 获批后的最小项目 JSON fixture。

以下仍暂缓：检索分词/BM25、DeepSeek 客户端、DOCX、真实 IPC、项目 UI、知识库兼容策略和认证存储。阶段 2 可以保存检索报告的稳定业务快照，但不得借此决定阶段 3 的 corpus/index 格式或算法。

## 必要性、复用与依赖

### 采用

- 继续使用已锁定的 `zod@4.4.3`。它适合 JSON、IPC、配置和外部输入的运行时解析，支持严格对象、判别联合、品牌类型和交叉字段校验。本阶段不再引入 Ajv、TypeBox、io-ts 或 JSON Schema 代码生成，避免双重事实源。
- ID 由注入的 `IdGenerator` 产生，生产适配器使用平台 `crypto.randomUUID()`；不引入 `uuid` 包。
- 时间由注入的 `Clock` 产生；不引入日期库。磁盘只保存 UTC RFC 3339 字符串，不用本地时区字符串或 Unix 浮点秒。
- 图关系使用小规模 `Map`/`Set` 遍历；状态迁移使用显式表和纯函数。
- 文件持久化使用 Node `fs/promises`、同目录临时文件、`fsync`、原子 rename/replace、有限 Windows 重试和恢复意图记录。

### 不采用

- 不引入 XState：当前只有一个明确且很小的任务状态图，显式迁移表更易审计。
- 不引入 ORM、SQLite、事件存储或数据库迁移框架：首版要求项目目录可直接复制，当前聚合规模不足以抵偿额外格式、原生依赖和恢复复杂度。
- 不引入 Immer 或不可变集合库：领域命令返回新聚合，成功正文放入不可变内容文件即可。
- 不直接依赖现有传递依赖 `proper-lockfile` 或 `write-file-atomic`。它们不能替代本项目跨正文、task、version、snapshot、commit 和 head 的事务协议。锁租约按 `0004-project-storage-review.md` 使用标准库实现并接受故障注入审查。

任何 package 调用 Zod API 都必须把 Zod 声明为自身精确生产依赖，不能依赖 workspace 的传递可见性。

## Package 边界

依赖方向固定为：

```text
shared primitives <- domain <- project
        ^               ^
        +---- future explicit IPC DTO mapping
```

- `shared`：只放无业务副作用的基础值 Schema、安全错误和未来 IPC envelope；不得放项目文件路径解析或版本状态转换。
- `domain`：依赖 shared 基础值，定义项目聚合及纯命令；不得导入 Electron、React、Node 文件系统、网络或 AI SDK。
- `project`：依赖 domain/shared，拥有磁盘 V1、路径约束、哈希、原子写入、恢复和迁移；不得包含 UI、凭据或 AI 调用。
- IPC DTO 与磁盘 Schema 必须分离。未来 shared 中的 DTO 通过显式 mapper 映射领域视图，不允许直接导出 head、snapshot 或 record Schema 给 renderer。

## 统一序列化约定

| 值 | 约定 |
| --- | --- |
| 实体 ID | UUID 字符串；TypeScript 分别 brand 为 `ProjectId`、`VersionId`、`CommentId`、`PromptId`、`TaskId`、`RetrievalReportId`、`ExportRecordId`，禁止混用 |
| 时间 | UTC RFC 3339，必须以 `Z` 结尾并带 3 至 9 位小数；生产至少毫秒精度，测试可注入七位小数 |
| 排序 | `createdAt` 升序后按 ID 升序；关系和 latest 判断绝不依赖时间 |
| 哈希 | 小写 64 位十六进制 SHA-256 |
| JSON | UTF-8、LF、一个末尾换行；对象拒绝未知字段；数字必须 finite |
| 逻辑路径 | 项目根内的 `/` 分隔相对路径；拒绝绝对路径、盘符、UNC、NUL、反斜杠、`.`/`..` 段和越界符号链接 |
| 正文 | UTF-8 Markdown 或纯文本；成功版本在 trim/产品内容校验后必须非空 |

时间只用于显示和稳定排序。即使两个实体时间相同或系统时钟回退，UUID 和显式父子关系仍保证身份及关系正确。

建议基础接口：

```ts
interface Clock {
  now(): Timestamp;
}

type EntityKind =
  | 'project'
  | 'version'
  | 'comment'
  | 'prompt'
  | 'task'
  | 'retrievalReport'
  | 'exportRecord';

interface IdGenerator {
  next(kind: EntityKind): string;
}

interface TextArtifactRef {
  relativePath: ProjectRelativePath;
  sha256: Sha256;
  byteLength: number;
  mediaType: 'text/markdown' | 'text/plain';
  encoding: 'utf-8';
}

interface StoredObjectRef {
  relativePath: ProjectRelativePath;
  sha256: Sha256;
  byteLength: number;
  kind:
    | 'minutes'
    | 'versionContent'
    | 'promptContent'
    | 'prompt'
    | 'task'
    | 'version'
    | 'comment'
    | 'retrievalReport'
    | 'exportRecord'
    | 'snapshot';
  entityId: string;
  recordVersion: number;
}
```

ID 生成后必须立即经对应 brand Schema 解析。测试为不同实体注入不同且格式有效的 UUID，不能用同一固定值掩盖引用串错。

存储层另有 `CommitId`、`TransactionId` 和 `SnapshotId` 品牌 UUID，由 `packages/project` 产生；它们不能冒充业务实体 ID。

## 领域聚合与磁盘 V1 envelope

业务 Schema 和存储协议必须分开编号。领域纯函数处理 hydration 后的 `ProjectAggregateV1`：

```ts
interface ProjectAggregateV1 {
  format: 'news-writer-project';
  schemaVersion: 1;
  projectId: ProjectId;
  revision: number;
  name: string;
  profile: 'official' | 'other';
  status: 'active' | 'archived';
  createdAt: Timestamp;
  updatedAt: Timestamp;
  archivedAt?: Timestamp;
  createdWith: RuntimeVersionSnapshot;
  lastWrittenWith: RuntimeVersionSnapshot;
  minutes: MinutesSnapshot;
  projectConfig: GenerationConfigOverrides;
  latestVersionId: VersionId | null;
  prompts: PromptRecord[];
  tasks: TaskRecord[];
  versions: VersionRecord[];
  comments: CommentRecord[];
  retrievalReports: RetrievalReport[];
  exportRecords: ExportRecord[];
}

interface RuntimeVersionSnapshot {
  appVersion: string;
  electronVersion: string;
  chromiumVersion: string;
}
```

磁盘不把该聚合的大段文本塞进一个持续覆盖的 JSON。`0004-project-storage-review.md` 规定 `project.json` 是可重建 head，完整当前状态位于不可变 snapshot，实体及其修订位于不可变 record/content 文件。最小 envelope 为：

```ts
interface ProjectHeadV1 {
  format: 'news-writer-project';
  storageVersion: 1;
  schemaVersion: 1;
  projectId: ProjectId;
  revision: number;
  headCommitId: CommitId;
  headCommitHash: Sha256;
  snapshot: StoredObjectRef;
  state: ProjectStateIndexV1;
}

interface ProjectStateSnapshotV1 {
  format: 'news-writer-state-snapshot';
  storageVersion: 1;
  schemaVersion: 1;
  projectId: ProjectId;
  revision: number;
  commitId: CommitId;
  state: ProjectStateIndexV1;
}

interface ProjectStateIndexV1 {
  project: ProjectMetadataV1;
  currentMinutes: StoredObjectRef;
  latestVersionId: VersionId | null;
  prompts: StoredObjectRef[];
  tasks: StoredObjectRef[];
  versions: StoredObjectRef[];
  comments: StoredObjectRef[];
  retrievalReports: StoredObjectRef[];
  exportRecords: StoredObjectRef[];
}
```

`StoredObjectRef` 至少包含相对路径、byteLength、SHA-256、内容 kind、entityId 和记录/编码版本。Project 服务读取 head -> commit -> snapshot -> records/content，严格校验后才组装 `ProjectAggregateV1` 交给 domain。domain 可以把 TextArtifactRef 当作不可变值携带，但不得解析、拼接或生成路径，也不知道 commit hash 或 Node 文件系统。

`revision` 从 0 开始，每个已提交 commit 恰好加 1，供主进程会话和未来 IPC 做 optimistic concurrency。`updatedAt` 不是并发令牌。head、commit、snapshot 和当前 task record 的 revision/transactionId 必须互相一致，不能从 mtime 或最大文件名推断当前状态。

`MinutesSnapshot` 至少包含 `minuteId`、`revisionId`、`createdAt`、`contentRef`。每次保存纪要写一个新的不可变内容文件和记录并由新 snapshot 切换引用；任务保存它实际使用的 `MinutesSnapshot`，后续纪要编辑不改变在途或历史任务。

`profile` 是项目身份，不是每次生成可任意覆盖的参数。用户配置中的默认新闻稿类型只用于新建项目初值；项目创建后显式变更 profile 只允许在 prompts/tasks/versions/comments/retrievalReports/exportRecords 全为空时完成。首版一旦产生任何流程记录就拒绝切换，避免同一项目混合 official/other 规则。

归档只改变 `status`、`archivedAt`、`revision` 和 `updatedAt`。归档项目允许打开、浏览、diff 和导出已有版本；禁止编辑纪要/配置/批注、切换 latest 或发起任务，恢复 active 后重新允许。

## 配置 Schema 与覆盖不变量

V1 可覆盖字段限定为：

```ts
interface GenerationConfigValues {
  model: string; // trim 后 1..128 字符
  reasoningEffort: 'off' | 'low' | 'medium' | 'high';
  targetChannel: string; // trim 后 1..120 字符
  maxWords: number; // 整数 100..10000
  requestTimeoutMs: number; // 整数 1000..600000
}

type GenerationConfigOverrides = Partial<GenerationConfigValues>;
type ConfigSource = 'default' | 'user' | 'project' | 'task';

interface ResolvedGenerationConfigSnapshot {
  schemaVersion: 1;
  provider: 'deepseek';
  profile: 'official' | 'other';
  values: GenerationConfigValues;
  sources: { [K in keyof GenerationConfigValues]: ConfigSource };
}
```

规则：

1. 对每个允许覆盖的 key 独立执行 `task > project > user > default`，只把“字段存在”视为覆盖；空字符串和非法数字不是“缺省”，而是校验失败。
2. `sources[key]` 必须等于实际获胜层，不能由调用者传入；解析器同时生成 values 和 sources。
3. `provider` 固定为 DeepSeek，`profile` 固定为项目 profile；二者不接受单次覆盖。
4. API Key、认证状态、base URL、任意 headers 和代理凭据不属于这些 Schema；严格对象应拒绝这些字段。
5. task 和成功 version 均保存完整 resolved snapshot。后续用户/项目默认值改变不能影响历史任务。
6. temperature、thinking wire 字段等尚未经过 AI 模块审查，不进入 V1 公开配置；AI 模块如确需新增，必须扩展配置 Schema 并补迁移/兼容测试，不能塞进 `Record<string, unknown>`。

## PromptRecord

Prompt 只表示一次任务实际发送的最终消息快照，不保存预览草稿或“系统原始 Prompt”：

```ts
interface PromptRecord {
  id: PromptId;
  createdAt: Timestamp;
  purpose: 'draftGeneration' | 'aiReview' | 'commentRevision';
  messages: Array<{
    role: 'system' | 'user';
    contentRef: TextArtifactRef;
  }>;
  editedByUser: boolean;
  editWarningAcknowledgedAt?: Timestamp;
}
```

- messages 至少一项并按实际发送顺序保存；每个 contentRef 指向实际发送的逐字 UTF-8 内容，不做发送后的重新渲染、脱敏替换或换行规范化。
- 为遵守“允许用户删除 Prompt 内容”，Prompt content artifact 可以是 0 bytes；API/服务端可拒绝，但本地不能静默恢复系统文字。成功版本仍要求 AI 结果非空。
- `editedByUser=true` 时必须有 `editWarningAcknowledgedAt`，且不晚于 Prompt/task 创建时间；false 时不得有该字段。
- 禁止 `originalPrompt`、`systemGeneratedPrompt`、diff 或可逆编辑历史字段。
- Prompt 与任务一对一：Task 引用 Prompt；Prompt 不反向保存 taskId，避免双向更新。

## VersionRecord

```ts
interface VersionRecord {
  id: VersionId;
  createdAt: Timestamp;
  parentVersionId: VersionId | null;
  createdBy: 'draftGeneration' | 'aiReview' | 'commentRevision';
  sourcePromptId: PromptId;
  taskId: TaskId;
  taskStatusSnapshot: 'succeeded';
  configSnapshot: ResolvedGenerationConfigSnapshot;
  contentRef: TextArtifactRef;
}
```

- Version 只代表成功且经内容校验的新闻稿，没有 pending/failed/cancelled/empty 版本。
- Version 元数据与 `contentRef` 指向的正文一经提交不可修改、覆盖或删除。
- 第一版是唯一允许 `parentVersionId=null` 的 root；以后每版必须引用同项目已有版本。V1 形成单根树而不是多个无关 root。
- `createdAt` 只做显示；“最新版”只由 Project 的 `latestVersionId` 决定。
- `sourcePromptId`、`taskId` 和 `configSnapshot` 显式保留，不能只经文件名或可变 task 间接推断。

## CommentRecord 与稳定锚点

版本正文不可变，因此不需要引入复杂协同编辑锚点库。使用 Monaco/JavaScript 一致的 UTF-16 code-unit offset，加精确引用和上下文即可稳定定位：

```ts
interface TextQuoteAnchor {
  kind: 'textQuote';
  contentSha256: Sha256;
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
}

interface CommentRecord {
  id: CommentId;
  revision: number;
  versionId: VersionId;
  anchor: TextQuoteAnchor;
  quotedText: string;
  body: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

`start/end` 是非负整数且 `start < end`；`exact`、`quotedText` 和 trim 后的 `body` 非空；`quotedText === exact`。项目打开和批注写入时必须读取版本正文并验证 hash 及 `content.slice(start, end) === exact`。prefix/suffix 可为空，但各限制最大长度，只用于重复文本诊断，不能在不匹配时悄悄重绑。

批注在业务上永久属于版本，但必须与不可变 `VersionRecord` 分开保存：Version 的正文/生成元数据不可变，Comment 是由 `versionId` 所有的可变附属记录。批注每次编辑产生 `revision + 1` 的不可变 record，当前 project snapshot 切换到最新修订；旧修订仍可用于 task snapshot 和恢复。V1 不实现批注删除、转移、resolved 或自动继承；如以后需要删除语义，应以显式 tombstone 设计另行审查。

领域命令必须执行：

- 只有 `comment.versionId === project.latestVersionId` 且项目 active 时可新增或编辑。
- 把历史版设为 latest 后，其原批注立即恢复可编辑；其他版本同时变只读。
- 编辑只能改变 anchor、quotedText、body 和 updatedAt，不能改变 id、versionId 或 createdAt。
- 切换 latest 不复制、迁移或删除任何批注。

## TaskRecord 与状态机

所有 AI 任务在用户确认最终 Prompt 后才持久化，因此从 queued 起就有 prompt、配置和输入快照：

```ts
interface TaskBase {
  id: TaskId;
  sequence: number;
  kind: 'draftGeneration' | 'aiReview' | 'commentRevision';
  createdAt: Timestamp;
  updatedAt: Timestamp;
  parentVersionId: VersionId | null;
  expectedLatestVersionId: VersionId | null;
  baseProjectRevision: number;
  promptId: PromptId;
  configSnapshot: ResolvedGenerationConfigSnapshot;
  minutesSnapshot: MinutesSnapshot;
  supplementalFacts?: string;
  retrievalReportId?: RetrievalReportId;
  commentSnapshot: CommentSnapshot[];
  history: Array<{ status: TaskStatus; at: Timestamp }>;
}
```

`CommentSnapshot` 完整复制 id、revision、versionId、anchor、quotedText、body、createdAt、updatedAt；TaskBase 另存 snapshot 时刻。`commentRevision` 必须快照父版本届时的全部批注，按 `createdAt,id` 稳定排序；其他 kind 的 `commentSnapshot` 必须为空。快照后修改原批注不得改变任务或实际 Prompt，新版本也不获得这些批注。

Task 使用 `status` 判别联合：

| 状态 | 额外字段 |
| --- | --- |
| `queued`、`preparing`、`requesting`、`processing` | 不得有 result、completedAt、transaction 或 error |
| `saving` | 还必须有 `successTransactionId`、`proposedVersionId` 和 `targetRevision` |
| `succeeded` | `completedAt`、`resultVersionId`、`successTransactionId`、`committedRevision`；不得有 error |
| `failed`、`cancelled`、`timedOut` | `completedAt`、`error`；不得有 resultVersionId |

允许迁移：

```text
queued -> preparing | failed | cancelled
preparing -> requesting | failed | cancelled | timedOut
requesting -> processing | failed | cancelled | timedOut
processing -> saving | failed | cancelled | timedOut
saving -> succeeded | failed
```

- 每次 task 状态或业务字段变化写一个新的不可变 TaskRecord，`sequence` 从 0 连续递增；snapshot 只引用该 task 当前 sequence。terminal 状态不可再迁移，history 第一项必须是 queued，最后一项必须等于当前 status，时间非递减且相邻项必须符合上表。
- `saving` 表示已进入不可中断的本地提交区。取消只在进入 saving 前生效；进入 saving 后 UI 应禁用取消，最终只能 succeeded 或 failed，避免“显示已取消但版本已落盘”。
- 每个项目最多一个非 terminal AI Task，首版不做并行生成。
- draftGeneration 只允许在尚无版本时以 null parent 创建第一版；aiReview/commentRevision 必须以创建任务时的 current latest 为 parent。
- 应用重开时，queued/preparing/requesting/processing 统一转为 failed + `TASK_INTERRUPTED`；saving 先走事务恢复，不能直接猜成失败或成功。

## RetrievalReport

本阶段只批准“历史任务可复现所需的报告快照”，不批准知识库文件或 BM25 实现：

```ts
interface RetrievalReport {
  id: RetrievalReportId;
  createdAt: Timestamp;
  knowledgeVersion: string;
  retrievalEngineVersion: string;
  redactedQueryText: string;
  querySha256: Sha256;
  factHints: {
    dates: FactHint[];
    times: FactHint[];
    locations: FactHint[];
    participants: FactHint[];
    missing: Array<'date' | 'location' | 'organizer'>;
  };
  hits: Array<{
    rank: number;
    documentId: string;
    title: string;
    score: number;
    promptExcerpt: string;
  }>;
}

interface FactHint {
  value: string;
  start: number;
  end: number;
  quote: string;
}
```

query 必须是实际检索使用的规范化、脱敏文本；hash 与 UTF-8 bytes 一致。hits 只保存实际进入 Prompt 的摘录，不保存完整原稿、原始路径或可重算引用。rank 从 1 连续递增，documentId 唯一，score finite 且非负；空 hits 是合法成功报告。`knowledgeVersion` 和 `retrievalEngineVersion` 当前作为非空 opaque 标识，不在本审查决定兼容策略。

报告可在用户检索后独立存在；Task 只单向引用实际用于该 Prompt 的 report，避免创建 task 后反向修改 report。

## ExportRecord

导出记录只在一次尝试完成后追加，使用成功/失败判别联合：

```ts
interface ExportBase {
  id: ExportRecordId;
  versionId: VersionId;
  attemptedAt: Timestamp;
  completedAt: Timestamp;
  fileName: string;
  destinationDisplay?: string;
  templateVersion: string;
  appVersion: string;
}

type ExportRecord =
  | (ExportBase & {
      status: 'succeeded';
      outputSha256: Sha256;
      byteLength: number;
    })
  | (ExportBase & {
      status: 'failed';
      error: SafeAppError;
    });
```

为满足可移植性与路径隐私，V1 不持久化外部绝对导出路径。`fileName` 是实际文件名；`destinationDisplay` 如存在只能是经清理的非敏感展示标签，不含盘符、目录分隔符或用户名。这是对功能矩阵 D12“目标路径”的主动收窄，已与 `0004-project-storage-review.md` 的存储边界一致。导出记录引用成功版本，永不改变版本、comments 或 latest。导出服务输入只能是指定版本正文和显式模板配置，不能接收整个 ProjectAggregate，从接口层防止批注、Prompt、检索和任务数据进入 DOCX。

## SafeAppError

磁盘和 IPC 共用安全、受限的错误快照，不保存任意对象、stack、headers、请求体、完整服务响应或 cause：

```ts
interface SafeAppError {
  code:
    | 'AUTH_REQUIRED'
    | 'AUTH_REJECTED'
    | 'RATE_LIMITED'
    | 'NETWORK_UNAVAILABLE'
    | 'SERVICE_UNAVAILABLE'
    | 'REQUEST_TIMEOUT'
    | 'REQUEST_CANCELLED'
    | 'PROTOCOL_INVALID'
    | 'EMPTY_RESPONSE'
    | 'CONTENT_INVALID'
    | 'TASK_INTERRUPTED'
    | 'PROJECT_NOT_FOUND'
    | 'PROJECT_ALREADY_EXISTS'
    | 'PROJECT_NOT_WRITABLE'
    | 'PROJECT_FILESYSTEM_UNSUPPORTED'
    | 'PROJECT_LOCKED'
    | 'PROJECT_LOCK_RECOVERY_REQUIRED'
    | 'PROJECT_LOCK_COMPROMISED'
    | 'PROJECT_CONFLICT'
    | 'PROJECT_PATH_INVALID'
    | 'PROJECT_PATH_ESCAPE'
    | 'PROJECT_SCHEMA_INVALID'
    | 'PROJECT_SCHEMA_TOO_NEW'
    | 'PROJECT_MIGRATION_FAILED'
    | 'PROJECT_READ_ONLY'
    | 'PROJECT_STATE_CONFLICT'
    | 'PROJECT_HASH_MISMATCH'
    | 'PROJECT_RECOVERY_REQUIRED'
    | 'PROJECT_RECOVERY_AMBIGUOUS'
    | 'PROJECT_DISK_FULL'
    | 'PROJECT_ATOMIC_REPLACE_FAILED'
    | 'PROJECT_IO_ERROR'
    | 'UNKNOWN';
  occurredAt: Timestamp;
  safeMessage: string;
  retryable: boolean;
  httpStatus?: number;
  retryAfterSeconds?: number;
  diagnosticId?: string;
  transactionId?: TransactionId;
  suggestedAction?: string;
  causeCode?: string;
}
```

错误 code 是稳定断言面，safeMessage/suggestedAction 是已脱敏的人类说明但不是协议 key。`causeCode` 只允许经过 allowlist 的系统错误码，例如 `ENOSPC`，不能放路径或原始异常文本。HTTP body 只允许在内存中用于受控映射，不能进入 SafeAppError。取消消息必须说明客户端已停止等待，但服务端可能继续处理或计费。

## 聚合不变量

解析 head、commit、snapshot 和各 record 只证明各自字段形状；hydrate 后必须运行 `validateProjectAggregate`。至少检查：

1. 所有同类实体 ID 唯一，全部引用存在且属于当前聚合。
2. versions 为空时 latest 必须为 null；非空时 latest 必须引用某个 version。
3. 版本图只有一个 root、无环、无悬空 parent；任意 latest 的“当前有效链”是沿 parent 回到 root 的唯一路径，其他版本保留为分支。
4. 每个 Version 对应且只对应一个 succeeded Task；Task 的 resultVersionId、parent、kind、prompt 和 config 与 Version 完全一致。
5. failed/cancelled/timedOut task 没有 resultVersionId，也没有 Version 反向引用它。
6. Prompt 最多被一个 Task 引用；Task 必须引用 purpose/kind 一致的 Prompt。
7. comment.versionId 必须存在；锚点 hash、offset 和 quote 必须与该版本正文一致。
8. commentRevision 的 commentSnapshot 恰好来自 parentVersionId，其他 task 不带批注快照。
9. retrieval/export 引用存在；检索报告不得含路径字段，导出只引用成功版本。
10. task/version config snapshot 的 profile 等于 Project profile，provider 固定 deepseek，来源和值一致。
11. 最多一个非 terminal task；全部 task history 有效。
12. 所有内容引用位于项目根内，文件存在、byteLength 和 SHA-256 相符；符号链接解析后仍在根内。

Schema 无法可靠识别字符串中伪装的 API Key。项目服务在保存 Prompt、补充事实、安全消息和配置前还必须执行 secret/敏感字段扫描；不能因 Zod 解析通过就宣称无凭据。

## 版本、分支和批注命令

领域层至少公开以下纯命令；命名可调整，但职责不得合并进 renderer 或存储实现：

```ts
createProject(input, deps): ProjectAggregateV1
archiveProject(project, expectedRevision, at): ProjectAggregateV1
restoreProject(project, expectedRevision, at): ProjectAggregateV1
saveMinutes(project, input, expectedRevision, at): ProjectAggregateV1
updateProjectConfig(project, overrides, expectedRevision, at): ProjectAggregateV1
setLatestVersion(project, versionId, expectedRevision, at): ProjectAggregateV1
addComment(project, input, expectedRevision, deps): ProjectAggregateV1
editComment(project, input, expectedRevision, at): ProjectAggregateV1
queueTask(project, input, expectedRevision, deps): ProjectAggregateV1
transitionTask(project, taskId, nextStatus, payload, at): ProjectAggregateV1
commitSuccessfulVersion(project, input, expectedRevision, deps): ProjectAggregateV1
recordRetrieval(project, report, expectedRevision): ProjectAggregateV1
recordExport(project, record, expectedRevision): ProjectAggregateV1
getCurrentVersionChain(project): VersionRecord[]
getBranches(project): BranchSummary[]
validateProjectAggregate(project, artifacts): ValidationIssue[]
```

每个修改命令先验证 expectedRevision、active/read-only 规则和引用，再返回新聚合；不得原地修改输入。`setLatestVersion` 只改 latest/revision/updatedAt。它不删除后代、不改 createdAt、不重排实体，也不迁移批注。

## 成功版本事务

`commitSuccessfulVersion` 是阶段 2 的最高风险边界，必须满足：

### 前置条件

- Task 当前为 processing，项目 active，且是项目唯一非 terminal task。
- `project.revision` 等于调用者 expectedRevision。
- `project.latestVersionId === task.expectedLatestVersionId === task.parentVersionId`；第一版三者均为 null。
- Task 的 Prompt、resolved config、minutes、retrieval 和 comment snapshots 已持久化且通过聚合校验。
- AI 结果已完成协议校验和产品内容校验，trim 后非空，不是纯问题清单/内部说明。
- 取消或超时信号在进入 saving 前再检查一次。
- 调用方提供预生成并可在重试时复用的 `successTransactionId`；VersionId 也在进入 saving 前固定，重试不得另造版本。

### 提交协议

1. 先以一次普通 commit 把 task 的新 sequence 转为 saving，记录 `successTransactionId`、`proposedVersionId` 和 `targetRevision`；此后不接受取消。
2. 纯领域转换产生确定的 VersionRecord、succeeded TaskRecord 和下一 ProjectAggregate；Version/Task 必须共享 taskId、versionId、parent、Prompt 和 config，succeeded Task/commit details 必须共享 successTransactionId 和目标 revision。
3. 按 `0004-project-storage-review.md` 在 `.news-writer/staging/<transactionId>` 写 prepare、Version 正文、Version record、succeeded TaskRecord 和下一 snapshot，逐个 flush/fsync。
4. 发布全部不可变 payload 和 snapshot。已存在目标只在 entityId、transactionId 和 hash 全部相同时作为幂等重试接受，否则报冲突。
5. 发布不可变 commit 清单。它至少包含 operation=`completeTaskWithVersion`、transactionId、taskId、versionId、base/target revision、parent commit/hash、snapshot ref/hash 和全部 writes；该 commit 的 transactionId 必须等于 Task 的 successTransactionId。
6. **commit 清单成功发布是事务提交点。** 该 commit 的 snapshot 必须同时呈现：新 Version、Task succeeded/resultVersionId/successTransactionId/committedRevision、latest 指向新 Version、project revision +1。
7. 从已验证 snapshot 生成 `project.json` head temp 并原子替换；head 保存该 commit ID/hash 和 snapshot ref。重新读取验证后清理或隔离 staging。

commit 发布前的失败可以把 task 另行提交为 failed，但已有 Version 正文哈希和 latestVersionId 必须保持不变。commit 发布后即使 head 替换失败，也不得把业务任务改成 failed 或诱导用户重新生成；返回 `PROJECT_RECOVERY_REQUIRED`，重开后按唯一连续 commit 前滚 head，同一 transactionId 重试只返回原结果。

正文/records 已发布但 commit 未发布时只是 orphan，不得按文件名自动注册；首版保留或隔离，不自动删除未知对象。head 或 snapshot 已引用的正文缺失/hash 不符时项目必须停止写入并报损坏，不能生成空文件补洞。

该操作的 commit details 至少为以下稳定字段，恢复和幂等判断不得从 writes 路径反推：

```ts
interface CompleteTaskWithVersionCommitDetails {
  operation: 'completeTaskWithVersion';
  successTransactionId: TransactionId;
  taskId: TaskId;
  fromTaskSequence: number;
  toTaskSequence: number;
  versionId: VersionId;
  baseRevision: number;
  revision: number;
}
```

## 磁盘布局与写入

物理布局和提交协议以 `0004-project-storage-review.md` 为权威，最小结构为：

```text
<project>/
  project.json
  content/
    minutes/<minute-id>/<revision-id>.md
    versions/<version-id>.md
    prompts/<task-id>/<message-index>.txt
  records/
    prompts/<prompt-id>.json
    versions/<version-id>.json
    comments/<comment-id>/<revision-id>.json
    tasks/<task-id>/<sequence>.json
    retrieval/<retrieval-id>.json
    exports/<export-id>.json
  .news-writer/
    commits/<revision>-<commit-id>.json
    snapshots/<revision>-<commit-id>.json
    staging/<transaction-id>/
    write.lock/
```

- commit 清单是事务提交点，snapshot 是完整状态索引，`project.json` 只是可重建 head；不能扫描 content/records 的文件名或 mtime 重建 latest、任务状态或版本树。
- content、record、snapshot 和 commit 都只追加；纪要/批注“编辑”和 task 状态变化通过新修订/sequence 表达。
- 一个进程内为 canonical project root 建立互斥写队列；跨进程使用原子 mkdir 租约锁，同一 root 只能有一个本应用写会话。
- Windows rename 遇到短暂 sharing violation 时只按固定上限退避重试；磁盘写满、权限或持续占用必须返回结构化错误，不能无限重试。
- 打开项目先验证 head/commit/snapshot/object 链，再处理唯一可证明的前滚；多个有效后继、hash 损坏或关系歧义必须停止，不能猜测。
- “任意可写目录”限定为 Windows 上通过排他创建、同目录替换、刷新、路径和锁能力探测的目录；普通写权限检查不够。
- 项目可移植复制的验收前提是项目已关闭或处于静止状态；首版不承诺对正在提交的目录做在线一致快照。
- 可承诺应用进程崩溃恢复，以及断电后的 hash/commit 链检测与回退；不得宣称 Node/Windows 在任意硬件、驱动和文件系统上提供绝对断电原子性。

## 磁盘 Schema 与 IPC DTO 边界

未来 IPC 必须以主进程签发的 opaque `ProjectSessionId` 标识打开会话，不把项目根路径交给 renderer。每个写请求带 `expectedRevision`，主进程重新读取/使用权威聚合执行领域命令。

建议首批 DTO：

- `ProjectSummaryDto`：projectId、revision、name、profile、status、latestVersionId 和只读统计。
- `ProjectWorkspaceDto`：当前 minutes 文本、latest 正文、版本树摘要、latest 批注、有效配置来源；不含 artifact path、hash、完整 task diagnostics 或导出目录。
- `SetLatestVersionRequest`：sessionId、versionId、expectedRevision。
- `AddCommentRequest` / `EditCommentRequest`：sessionId、versionId/commentId、anchor、body、expectedRevision。
- `QueueTaskRequest`：sessionId、最终 messages、editedByUser、warning acknowledgement、允许的 task overrides、expectedRevision；renderer 不得提交 resolved config、task status、taskId、contentRef 或成功结果。
- `TaskStatusDto`：taskId、status、已发生 history 的状态/时间和 SafeAppError；不含百分比、headers 或原始响应。
- `ExportRequest`：sessionId、versionId、由主进程文件对话框取得的目标 token；renderer 不提交任意可信路径。

禁止把 `ProjectHeadV1`、`ProjectStateSnapshotV1` 或任意磁盘 record Schema 直接用作 IPC response，也禁止 IPC request 接收整个 Version/Task/Project 让 renderer 覆盖。disk-to-domain、domain-to-view 和 request-to-command mapper 必须有独立测试，未知字段一律拒绝。

## 迁移版本策略

1. `format` 是格式族标识；`storageVersion` 表示 head/commit/snapshot/object 物理协议，`schemaVersion` 表示领域字段，二者都是从 1 开始的独立整数，不使用应用 semver 代替。
2. 先用最小 envelope Schema 只读取 format/storageVersion/schemaVersion；任一高于当前支持版本时停止写入，不尝试降级或“尽量读取”后写回。
3. 迁移函数固定为纯的逐级转换 `migrateVnToVnPlus1(raw): raw`；禁止跨级跳转、联网、读取用户配置或生成 AI 内容。
4. 每一步迁移后解析目标版本并运行聚合不变量；最终再验证所有内容文件 hash。
5. 迁移持有项目写锁，并以 operation=`migration` 的正常 transaction/snapshot/commit 发布；commit 前失败保持旧 head，commit 后 head 落后按普通恢复前滚。不得原地改旧 immutable object。
6. 迁移必须保留实体 ID、createdAt、版本关系、comments、实际 Prompt 和成功/失败语义；绝不能通过迁移把旧失败 task 补成 Version。
7. V1 不存在对 `news/outputs` 的 V0 导入器。测试用 V0 只能在未来真实 V2 设计时创建；当前可测试“V1 当前版本”“未来版本拒绝”和迁移注册表为空的行为，不能伪造不存在的历史格式。

## Coding agent 测试清单

### 必须通过的正向测试

1. 固定 Clock/IdGenerator 创建 active、revision 0、无版本且 latest null 的 official/other 项目。
2. 四层配置逐字段覆盖并产生正确 source map；历史 task/version snapshot 不随默认值变化。
3. queued 到 succeeded 的完整合法状态链和各类 terminal 失败链；history 可直接供 UI 显示阶段。
4. 初稿成功产生唯一 root；review/revision 产生正确 child，成功 task/version/prompt/config 双向一致。
5. `v1 -> v2` 后把 latest 切回 v1，编辑 v1 原批注，生成 v3；v2 完整保留，当前链为 v1/v3，再切回 v2 可恢复原链。
6. revision task 快照父版本全部批注；任务开始后修改批注不改变快照；v3 comments 为空。
7. 相同正文重复文本仍由 offset + hash + context 定位正确区间。
8. 空 hits RetrievalReport 合法；有 hits 时 rank、score、实际 excerpt 和 opaque knowledge version round-trip。
9. 成功和失败 ExportRecord 均保留，导出不改变 latest/version/comment；给 documents 的 DTO 只有指定正文和模板输入。
10. 关闭项目或确认无在途提交后复制到新根，所有逻辑相对路径、关系和 hash 仍通过；不需要用户配置或 API Key。
11. 成功事务各崩溃点恢复幂等：提交前无 Version，提交后完整 Version；绝不出现成功空版或 latest 悬空。
12. V1 round-trip 字段稳定、未知未来 storage/schema version 只读拒绝、迁移失败保持原 head/commit 链不变。

### 必须拒绝的反例

1. 非 UUID/串错品牌 ID、非 UTC 时间、NaN/Infinity、未知字段、绝对/越界/反斜杠路径、hash 或 byteLength 不符。
2. latest 悬空、多 root、parent 悬空、自父、环、Task/Version parent 不一致、createdAt 最晚却冒充 latest。
3. failed/cancelled/timedOut task 带 resultVersionId，succeeded task 无 Version，Version 引用非成功 task 或空正文。
4. terminal 再迁移、跳过状态、history 与 status 不一致、saving 取消、同时两个非 terminal task。
5. stale expectedRevision、任务提交期间 latest 已切换、项目已归档、正文目标文件已存在。
6. 给非 latest 版本新增/编辑批注、改变 comment.versionId、锚点 hash/quote/offset 不匹配、自动重绑重复文本。
7. revision 混入其他版本批注、继承父批注到新版本、任务开始后回读可变 comments 替换快照。
8. `editedByUser=true` 却没有警告确认、false 却带确认时间、保存 originalPrompt；但空的最终 Prompt content 本身不得被 Schema 阻止。
9. 配置中出现 apiKey/baseUrl/headers/任意扩展字段，非法范围被当作缺省，source map 与最高优先级不一致，task profile 与项目不一致。
10. RetrievalReport 含绝对 source path、重复 documentId、非连续 rank、负数/非有限 score、query hash 不符；合法无命中不得被当错误。
11. failed ExportRecord 无 SafeAppError、succeeded 无 output hash，export 引用不存在版本，导出 DTO 意外包含 comments/Prompt/retrieval/task。
12. SafeAppError 含 stack、cause、Authorization、request/response body 或任意 details；IPC 返回磁盘 head/snapshot/record 或接受 renderer 指定 contentRef/status/resultVersionId。
13. 事务在正文/record 落盘后 commit 前崩溃时扫描文件名自动造版；commit/snapshot 引用缺失正文时静默写空文件。
14. storageVersion/schemaVersion 过新仍写入、迁移跨级跳过验证、迁移改变 ID/parent/latest 或把失败任务变成功版本。

项目 fixture 获准后只创建：一个线性项目、一个分支项目和一个损坏项目。当前没有真实旧 Schema，因此不创建伪造“可迁移旧项目”；等首次 V2 决策时再冻结真实 V1 作为迁移 fixture。每个 JSON fixture 必须直接通过正式磁盘 Schema，并配一个最小反例；不得复制 `news` 内容。

## 阶段 2 退出门槛

本审查批准的是编码边界，不是阶段 2 最终验收。实现后必须由另一独立 review agent 确认：

- domain 在不启动 Electron、无文件系统和网络时通过全部状态/分支/批注/配置测试；
- project 对每个外部 head、prepare、commit、snapshot、record 和内容文件运行 Schema、hash、链及聚合校验；
- 成功版本事务完成故障注入测试，失败/取消/超时/空内容不改变已有版本或 latest；
- 目录能力探测、静止项目复制、中文长路径、只读目录、磁盘错误、hash 损坏和恢复流程通过；
- shared 没有把磁盘聚合误当 IPC DTO，renderer 不获得路径、凭据或任意写能力；
- 锁文件只增加本文批准且经许可证门禁的直接依赖；不存在重复状态机、UUID、日期、ORM 或持久化框架。

满足这些条件后，主 agent 才能把阶段 2 作为检索、AI、IPC 和 UI 的稳定依赖。
