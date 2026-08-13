# 0004 项目持久化独立门禁审查

- 状态：有条件批准进入 coding agent
- 审查日期：2026-08-09
- 审查范围：`packages/project` 的项目目录格式、事务写入、锁、恢复、路径安全、损坏检测和 Schema 迁移
- 不在范围：业务字段最终定义、领域状态机、Electron IPC、AI、知识库、凭据和 DOCX
- 约束来源：`GOAL.md`、`IMPLEMENTATION_PLAN.md`、`AGENTS.md`、`FUNCTION_MATRIX.md`、`0001-engineering-baseline-review.md`、`0002-skeleton-review.md`

## 结论

批准使用 Node.js 24 标准库实现版本化目录存储，不批准引入数据库、原生扩展或新的文件写入/锁依赖。运行时 Schema 继续复用已批准并精确锁定的 Zod 4.4.3；`packages/project` 应直接声明它实际导入的 workspace/第三方依赖，不能依赖提升结果。

推荐模型不是“一个不断覆盖的大 JSON”，也不是直接向 JSONL 尾部追加，而是：

1. 正文、Prompt 和记录修订写成独立不可变文件。
2. 每次逻辑变更产生一个完整状态快照和一个不可变提交清单。
3. 根目录 `project.json` 只是当前 head 的可变、可重建视图。
4. 提交清单落盘后才算事务已提交；head 未更新时由恢复流程前滚。
5. 所有可变文件使用同目录临时文件、文件 `fsync`、关闭句柄、原子 `rename` 和 Windows 有界重试。
6. 一个项目同一时间只允许一个本应用写会话；跨进程使用原子 `mkdir` 获得租约锁，进程内再串行化事务。

该方案可以防止应用崩溃留下“半个成功版本”或让 `latestVersionId` 指向缺失内容，也能在项目复制后仅依靠目录内容恢复。它不能把 Node/Windows 没有提供的保证包装成产品承诺，以下三个边界必须被主 agent 固化：

- “任意可写目录”应解释为“Windows 上通过能力探测且支持所需文件语义的可写目录”。仅有写权限不代表云盘、异常 SMB、虚拟文件系统一定支持可靠的排他创建、替换和刷新。
- “项目复制可移植”应以项目已关闭或处于静止状态为验收前提。资源管理器实时复制一个正在提交的多文件目录不构成一致快照；若以后要求在线复制，需另立“创建项目快照”功能。
- Node 标准库可对文件句柄执行 `fsync`，但在 Windows 上不能可靠取得并刷新目录句柄。因此可承诺进程崩溃恢复和断电后的检测/回退，不能承诺任何硬件、驱动和文件系统组合下的绝对断电持久性。

这三个边界不是编码缺陷，而是原目标措辞比平台能力更宽。若产品坚持字面上的任意目录、在线复制或绝对断电保证，本审查应改为暂缓并重新选择平台约束或原生存储能力。

## 现状和模块边界

当前 `packages/project` 只有占位导出，没有可复用持久化实现。`news` 的直接 `write_text`、`save` 和文件重命名只提供反例，不得迁移。

`packages/project` 负责：

- 磁盘项目 envelope 和各历史 Schema；
- 项目路径解析、格式探测、读取限额和完整性校验；
- 单写者锁、进程内事务队列、原子文件辅助；
- staging、提交、恢复和迁移编排；
- 将 Node `SystemError` 映射为稳定的项目错误。

它不负责：

- 判断版本树、批注权限和任务状态是否合法；这些纯业务不变量由 `packages/domain` 提供，项目层只在提交前调用并保存其结果。
- 向 renderer 暴露路径或文件 API；`apps/desktop/main` 只能通过用例级 IPC 调用项目服务。
- 保存 API Key、用户认证、内置知识库或 Electron 运行环境。
- 生成 DOCX 或把外部导出文件复制进项目。

建议依赖方向保持 `project -> domain, shared, zod`。不得让 `domain` 反向依赖 `project` 或 `node:fs`。

## 成熟方案评审

审查时 npm registry 的当前候选如下；版本只用于评审，不表示批准加入锁文件。

| 方案 | 当前版本 / 许可证 | 可复用能力 | 不足 | 结论 |
| --- | --- | --- | --- | --- |
| Node `fs/promises`、`path`、`crypto` | Node 24.18.0 / MIT | `open('wx')`、`mkdir`、`FileHandle.sync()`、`rename`、`realpath`、SHA-256、UUID 均已具备 | 多文件事务、恢复和错误策略仍需项目层定义 | 采用 |
| Zod | 4.4.3 / MIT | 已批准；可为磁盘、迁移结果和提交清单提供严格运行时校验 | 不能替代引用完整性和领域不变量检查 | 复用，不算新框架 |
| `write-file-atomic` | 8.0.0 / ISC | 活跃维护；同进程同文件排队、临时文件、`fsync`、`rename` | 只处理单文件；不含 Windows rename 重试、跨进程锁、多文件提交或恢复清单 | 不引入 |
| `atomically` | 2.1.1 / MIT | 单文件临时写、`fsync`、有界文件系统重试 | 依赖 `stubborn-fs`/`when-exit`；长文件名回退会改变目标名称；仍不解决项目事务 | 不引入 |
| `proper-lockfile` | 4.1.2 / MIT | 使用原子 `mkdir`、mtime 精度探测和 heartbeat，是成熟锁租约参考 | 2022 后未更新；引入 3 个依赖；默认自动删除陈旧锁，不符合本项目“显式恢复、避免双写”的要求 | 借鉴协议，不引入 |
| `steno` / `lockfile` | 4.0.2 / 1.0.4 | 简单单文件写或锁 | 不提供本项目所需提交链、恢复和损坏模型 | 不引入 |
| SQLite、LevelDB、`fs-ext`、原生文件锁 | 不适用 | 可提供数据库事务或 OS 锁 | 原生 Node 扩展、Electron ABI 和便携打包成本；与已批准基线冲突 | 禁止 |

这里实现窄范围的标准库辅助不是重复造一个通用库。项目仍必须自定义提交清单、领域引用、恢复决策和迁移，这些候选均不能替代；再叠加单文件库只会形成两套重试和清理语义。

## 项目目录布局

首版建议格式：

```text
<project-root>/
  project.json
  content/
    minutes/<minuteId>/<revisionId>.md
    versions/<versionId>.md
    prompts/<taskId>.txt
  records/
    versions/<versionId>.json
    comments/<commentId>/<revisionId>.json
    tasks/<taskId>/<sequence>.json
    retrieval/<retrievalId>.json
    exports/<exportId>.json
  .news-writer/
    commits/<revision>-<commitId>.json
    snapshots/<revision>-<commitId>.json
    staging/<transactionId>/
      prepare.json
      payloads/...
    write.lock/
      owner.json
```

规则：

- `project.json` 是小型 head 和完整当前索引，不存大段正文；它可由最后一个有效提交和 snapshot 重建。
- `content` 与 `records` 中的每个文件写入后不可覆盖。纪要和批注的“编辑”通过新修订文件表达，snapshot 切换当前引用。
- 任务状态按不可变 sequence 追加，不能覆盖早期失败/取消记录。成功版本事务同时提交成功任务终态、版本正文、版本记录和新 `latestVersionId`。
- ID 使用 `crypto.randomUUID()` 产生的 ASCII UUID。内部路径不使用标题、用户名、日期或其他用户文本。
- 所有持久引用使用 `/` 分隔的项目相对路径；不得持久化盘符、UNC、`file://`、`\\?\` 或项目根绝对路径。
- 外部 DOCX 导出记录只保存文件名、结果和必要的非敏感显示信息。除非明确需要且另行审查，不保存开发机或用户目录绝对路径。
- `.news-writer/write.lock` 是瞬态状态；正常关闭后移除，不参与业务 Schema。其意外残留由锁恢复处理。
- 首版不自动删除未知孤儿对象。确定为本应用未提交 staging 的内容可以隔离到 staging/quarantine；垃圾回收需另行审查，避免误删用户数据。

`project.json` 至少包含存储 envelope：格式标识、`storageVersion`、业务 `schemaVersion`、`projectId`、`revision`、`headCommitId`、`headCommitHash` 和当前状态索引。存储版本与业务 Schema 版本必须分离，避免用一次编号同时表示物理协议和领域字段。

## 引用和完整性

每个 snapshot 和 commit 引用不可变文件时至少记录：

- 项目相对路径；
- 字节长度；
- SHA-256；
- 内容类别和对应实体 ID；
- 该文件适用的 Schema/编码版本。

SHA-256 对实际落盘字节计算，不依赖再次 `JSON.stringify` 后是否得到相同属性顺序。JSON 文件固定 UTF-8、无 BOM、末尾 LF；读取前先检查文件大小上限，再解析和运行严格 Schema。

仅校验 JSON 语法或 hash 不够。打开项目还必须验证：

- 所有引用存在且路径受控；
- ID 与路径、记录字段一致且无重复；
- `latestVersionId` 指向成功版本；
- 版本父关系无环且父节点存在；
- 批注归属的 `versionId` 存在；
- 成功版本引用成功、非空任务，失败/取消/超时任务没有版本；
- snapshot revision、commit parent 和 `project.json` head 构成唯一连续链。

业务不变量的具体实现由 domain 模块提供，project 模块负责在提交前和打开后调用同一验证入口，不能只信任磁盘上的旧校验结果。

## 原子文件协议

所有可变文件和不可变文件的首次发布都使用同一底层写入原语，但覆盖策略不同：

1. 在目标同一目录创建随机 ASCII 名称的 sibling temp，使用 `open(..., 'wx')` 防止碰撞。
2. 写入完整 Buffer；禁止多次无校验的隐式字符串追加。
3. 调用 `FileHandle.sync()`，确认成功后关闭句柄。
4. 不可变目标在发布前必须不存在；存在即报冲突或损坏，绝不覆盖。
5. 调用 `rename(temp, target)`；temp 与 target 同目录，`EXDEV` 属于实现错误，不允许退化为跨卷 copy。
6. 对 head 替换只重试 Windows 常见的 `EACCES`、`EPERM`、`EBUSY`。建议延迟 25、50、100、200、400、800、1000 ms；耗尽后保留旧 head 和已提交清单供恢复。
7. 不得先 unlink 旧 `project.json` 再 rename；那会在重试窗口制造“项目不存在”。
8. `ENOSPC`、`EDQUOT`、`EROFS`、`EXDEV`、路径校验错误和 hash 不一致不重试。
9. 成功 rename 后可以重新打开最终文件核对长度/hash；不能把无法执行目录 `fsync` 隐瞒为已完成强持久化。

进程内按 canonical project root 建立 promise queue，保证同一进程的多个调用也不能交错。队列不替代跨进程锁。

## 事务和提交协议

每次改变项目逻辑状态都必须带预先生成的 `transactionId`，调用者重试时复用同一 ID，避免“提交已发生但响应丢失”后创建重复版本。

事务顺序：

1. 已持有项目写锁；重新读取并验证当前 head，比较调用方的 `expectedRevision` 和 `headCommitId`。
2. 在 `.news-writer/staging/<transactionId>` 写入全部候选 payload、下一版 snapshot 和 `prepare.json`；逐个计算长度/hash并 `sync`。
3. `prepare.json` 列出 base revision、预期新 revision、操作类型、全部目标和下一 snapshot hash。写完并同步后才进入发布阶段。
4. 将不可变 payload 发布到 `content`/`records`；目标已存在时只允许其 hash 与同一事务完全一致，否则报冲突。
5. 发布 `.news-writer/snapshots/<revision>-<commitId>.json`，它包含完整的新状态索引。
6. 生成并发布不可变 commit 清单。清单包含 `commitId`、`parentCommitId/hash`、base/new revision、snapshot path/hash、全部新增对象及操作类型。
7. **commit 清单成功发布是事务提交点。** 从此恢复流程必须完成该事务，不能把它当普通失败后重新执行业务动作。
8. 从已验证 snapshot 生成 sibling temp `project.json`，同步并原子替换 head。
9. 重新读取 head 校验 revision、commit ID/hash，然后清理或隔离 staging。

如果步骤 7 后 head 替换持续失败，API 返回 `PROJECT_RECOVERY_REQUIRED`，携带非敏感 `transactionId` 和“重新打开项目恢复”的动作；不能返回普通 `failed` 诱导用户重复点击。

项目创建使用相邻的临时项目目录构建完整 genesis commit，最后 rename 为用户选择的新目录。首版应要求最终项目目录不存在；不要把半初始化结构直接散落到任意现有目录。

## 提交清单最小结构

字段名可随 Schema 审查微调，但语义不得减少：

```text
format / storageVersion
commitId / parentCommitId / parentCommitHash
transactionId / operation
baseRevision / revision / createdAt
snapshot: path / bytes / sha256 / schemaVersion
writes[]: path / bytes / sha256 / kind / entityId
```

commit 清单自身以原始字节计算 SHA-256；head 保存当前 commit hash，后续 commit 保存 parent hash。不得只凭文件名或 mtime 选择提交。

## 锁和并发打开

首版采用单写者、整段打开会话持锁，不支持两个 app 实例同时编辑同一项目。

1. canonicalize 项目根后，以原子 `mkdir('.news-writer/write.lock')` 获取锁。
2. 锁目录中的 `owner.json` 保存随机 `instanceId`、PID、进程启动时间、应用版本和 heartbeat 时间；不得包含用户名、凭据或项目内容。
3. 每 5 秒更新锁目录 mtime/owner，建议陈旧阈值至少 30 秒。计时器应 `unref`，但应用正常退出仍显式释放。
4. 锁存在且 heartbeat 新鲜时返回 `PROJECT_LOCKED`，展示“已在另一个窗口或进程打开”，不自动抢锁。
5. 锁疑似陈旧时返回 `PROJECT_LOCK_RECOVERY_REQUIRED`。只有用户明确选择恢复、heartbeat 仍旧、且本机 PID 检查没有证明原进程存活后，才能将旧锁原子改名到隔离目录，再竞争创建新锁。
6. 两个恢复者竞争时只有一个 `mkdir` 能成功；失败者回到 `PROJECT_LOCKED`。
7. 检测到锁目录被替换、mtime 不再属于本实例或 heartbeat 更新超过阈值时，当前会话立即停止写入并返回 `PROJECT_LOCK_COMPROMISED`。

这是应用级 advisory lock，不是 Windows mandatory lock。相同用户用编辑器或脚本直接修改项目文件无法被 Node 标准库完全阻止；revision/hash 校验会检测冲突，但不能承诺抵御具有同等文件权限的恶意进程。若必须强制阻止外部写入，需要原生锁或数据库，当前明确不批准。

同一应用进程重复打开 canonical root 时应复用现有项目会话或聚焦已有窗口，不能创建第二把逻辑锁。Windows 路径比较使用 canonical path 和不区分大小写的会话 key。

## 打开和恢复顺序

打开项目必须在向 renderer 返回业务数据前完成：

1. canonicalize root，检查固定文件/目录类型和读写能力；读取文件不得越过大小上限。
2. 获取写锁；只读诊断模式不得执行迁移或恢复写入。
3. 解析 `project.json` 外层 envelope；未知较新 `storageVersion` 或 `schemaVersion` 立即停止。
4. 验证 head 指向的 commit、snapshot 和全部被当前 snapshot 引用的对象。
5. 扫描 commit 目录中以当前 head 为 parent 的直接后继；只有一个完整、hash 正确、revision 连续的后继时才允许前滚。
6. 若存在多个有效后继、断链或 head 与 commit 互相矛盾，返回 `PROJECT_RECOVERY_AMBIGUOUS`，不得按时间或文件名猜测。
7. 对没有 commit 清单的 staging/prepare 视为未提交；不改变 head。首版保留或隔离，不自动发布。
8. 前滚后重新生成 `project.json`，运行完整 Schema、引用和领域不变量校验。
9. 需要迁移时执行连续迁移事务；全部成功后才返回可写项目。

恢复不能依据 `createdAt`、mtime 或“编号最大”猜最新版。时间只用于诊断和 UI，commit parent/hash 和 revision 才是恢复依据。

## 崩溃点矩阵

| 崩溃点 | 磁盘可见状态 | 重新打开时动作 | 业务结果 |
| --- | --- | --- | --- |
| 获取锁前 | 无变化 | 正常打开 | 未提交 |
| temp/payload 写一半 | staging 中有部分文件，无完整 prepare | 隔离 staging | 未提交 |
| prepare 已同步，payload 未全部发布 | 有 prepare，缺目标或 hash 不符，无 commit | 隔离并报告恢复记录 | 未提交 |
| payload 全部发布，snapshot 未发布 | 有未引用不可变孤儿，无 commit | 保留为孤儿，不改 head | 未提交 |
| snapshot temp 写一半 | 唯一目标不存在，temp 不完整 | 隔离 temp | 未提交 |
| snapshot 已发布，commit 未发布 | 完整 snapshot/对象，无 commit | 保留孤儿，不改 head | 未提交 |
| commit temp 写一半 | 无有效 commit | 忽略/隔离 temp | 未提交 |
| commit 已发布，head 未替换 | 旧 head + 唯一有效后继 commit | 校验后前滚 head | 已提交 |
| head temp 写一半 | 旧 head 仍完整 + 已提交 commit | 删除/隔离坏 temp并前滚 | 已提交 |
| rename 遭分享冲突且重试耗尽 | 旧 head + 已提交 commit | 返回 recovery required；重开前滚 | 已提交，待恢复确认 |
| head 已替换，校验/响应前崩溃 | 新 head 和 commit 均完整 | 幂等识别 transactionId | 已提交 |
| head 已替换，锁未释放 | 新 head + 陈旧锁 | 显式锁恢复后正常打开 | 已提交 |
| 磁盘写满发生在 commit 前 | 旧 head，可能有 staging/orphan | 不改 head，映射 ENOSPC | 未提交 |
| 断电导致新目录项丢失或乱序 | head/commit/object 可能不一致 | hash/链校验；优先最后一个完整提交，否则报损坏 | 检测并回退或停止，不伪造成功 |
| 外部进程在事务中改 head | expected revision/hash 不匹配 | 停止并报 conflict | 不覆盖外部状态 |

测试故障注入点必须与表中边界一一对应，不能只测最终 happy path。

## 路径安全

- 只接受由主进程文件选择器得到的项目根；renderer 不能传任意子路径。
- 新建项目先 `realpath` 已存在的父目录；打开项目使用 `realpath.native` 得到 canonical root。
- root 本身若为 junction/symlink可以解析到真实目标，但 `content`、`records`、`.news-writer` 及其下级不得是 symlink/junction；检测到即拒绝写入。
- 磁盘 Schema 中的相对路径必须是规范 `/`、非空、非绝对、无 `..`、`.`、NUL、反斜杠、冒号、尾随点/空格和 Windows 保留设备名。
- 每个路径通过 `path.resolve(root, ...segments)` 后，用 `path.relative(root, candidate)` 再次验证不为绝对且不以 `..` 越界。
- 内部文件名只能由类型化 ID 和固定扩展生成；标题、活动名和用户输入只作显示字段。
- 不手拼 `\\?\`；需要长路径时由 Node 路径 API/`path.toNamespacedPath` 在系统调用边界处理，绝不持久化 namespaced path。
- Windows 大小写不敏感；ID 统一小写 ASCII，打开时检测大小写碰撞。
- 当前威胁模型不声称消除同权限本地攻击者在检查与打开之间替换 reparse point 的 TOCTOU。关键写入前重新核验 canonical parent；更强保证需要 Windows 原生 handle API，当前暂缓。

项目复制到新绝对路径后，所有内部引用必须仍能解析。验收扫描项目持久数据，不得出现原项目根、API Key、认证目录、App 安装目录或知识库路径。

## 损坏检测与处理

分类并停止自动写入：

- head JSON 截断或 Schema 不合法；
- commit/snapshot/object 长度或 SHA-256 不符；
- 引用缺失、路径越界、类型不符；
- commit 分叉、断链、revision 回退或重复；
- 领域引用悬空、版本环、非法 latest、失败任务产出版本；
- 未知较新格式或缺少迁移链。

可自动恢复的仅限协议能唯一证明的状态：有效 commit 已提交但 head 落后、已知事务留下的 temp/staging、陈旧锁。正文 hash 错误、多个后继 commit 或用户文件被替换都不能“挑一个看起来最新的”继续。

首版不实现自动云端冲突合并、对象垃圾回收、用户编辑 JSON 后的修复或跨项目拼接。损坏错误应提供非破坏性的诊断报告和从备份恢复建议；不得把项目内容或绝对路径写入普通 renderer 日志。

## Schema 迁移

迁移必须满足：

1. 外层 envelope 先以最小严格 Schema 读取 `storageVersion`、`schemaVersion` 和大小限制。
2. 较新版本返回 `PROJECT_SCHEMA_TOO_NEW`；不得尝试“尽量读取”后写回。
3. 每个 migrator 只做 `N -> N+1`，输入和输出分别运行对应版本 Zod Schema。
4. migrator 是确定性纯函数，不读当前时间、环境变量、用户目录或知识库；迁移元数据由事务编排器另加。
5. 迁移在内存/新对象中完成，绝不原地改旧不可变文件。
6. 每一步作为 `operation=migration` 的正常提交，记录 from/to、应用版本和 transactionId；旧 commit/object 保留，可用于诊断回退。
7. 任何一步失败时 head 保持在最后一个完整 Schema；不能留下“字段迁了一半”的项目。
8. 存在版本缺口、重复 migrator 或迁移后领域不变量失败时拒绝打开写模式。
9. 迁移必须持有写锁；只读诊断不能静默迁移。

迁移不是旧 `news/outputs` 导入。首版仍明确不兼容原项目目录。

## 错误模型

项目层错误至少提供稳定 `code`、可展示安全消息、`retriable`、建议动作、可选 `transactionId` 和内部 `causeCode`。绝对路径、原始 JSON、Prompt 和正文只能进入受控诊断，不直接跨 IPC。

| code | 含义 | 可重试 | 建议动作 |
| --- | --- | --- | --- |
| `PROJECT_NOT_FOUND` | 根或入口不存在 | 否 | 重新选择目录 |
| `PROJECT_ALREADY_EXISTS` | 新建目标已存在 | 否 | 选择新目录名 |
| `PROJECT_NOT_WRITABLE` | 无写权限/只读介质 | 视情况 | 更改权限或目录 |
| `PROJECT_FILESYSTEM_UNSUPPORTED` | 能力探测不满足排他创建/替换/刷新 | 否 | 移到受支持目录 |
| `PROJECT_LOCKED` | 其他会话持有新鲜锁 | 是 | 聚焦原窗口或稍后重试 |
| `PROJECT_LOCK_RECOVERY_REQUIRED` | 锁疑似陈旧 | 用户确认后 | 执行显式恢复 |
| `PROJECT_LOCK_COMPROMISED` | 当前锁被替换或 heartbeat 失效 | 否 | 立即停止写入并重开 |
| `PROJECT_CONFLICT` | expected revision/head 不一致 | 否 | 重新加载，不自动覆盖 |
| `PROJECT_PATH_INVALID` | 相对路径、设备名或类型非法 | 否 | 报损坏/拒绝请求 |
| `PROJECT_PATH_ESCAPE` | 解析结果越过根 | 否 | 安全拒绝 |
| `PROJECT_SCHEMA_INVALID` | 当前 Schema 校验失败 | 否 | 诊断/从备份恢复 |
| `PROJECT_SCHEMA_TOO_NEW` | App 版本过旧 | 否 | 升级 App |
| `PROJECT_MIGRATION_FAILED` | 连续迁移失败 | 否 | 保留旧 head，报告步骤 |
| `PROJECT_HASH_MISMATCH` | 文件被截断或替换 | 否 | 停止写入，从备份恢复 |
| `PROJECT_RECOVERY_REQUIRED` | commit 已成立但 head 未完成 | 是，按事务恢复 | 重开并前滚，勿重复业务动作 |
| `PROJECT_RECOVERY_AMBIGUOUS` | 多分支提交或链冲突 | 否 | 人工诊断，禁止猜测 |
| `PROJECT_DISK_FULL` | `ENOSPC`/配额不足 | 条件满足后 | 释放空间并按 transactionId 恢复 |
| `PROJECT_ATOMIC_REPLACE_FAILED` | Windows 分享冲突重试耗尽且尚未 commit | 是 | 关闭占用程序后重试 |
| `PROJECT_IO_ERROR` | 其他已脱敏文件系统错误 | 视 cause | 按 UI 指引处理 |

## 测试门禁

### 纯单元测试

- 相对路径验证：盘符、UNC、`..`、反斜杠、ADS、NUL、保留设备名、尾点/空格、大小写碰撞。
- commit parent/hash/revision 链和 transactionId 幂等。
- 错误映射只允许已知 `SystemError.code`，不泄露绝对路径或内容。
- 每个 Schema 版本正反例、未知字段、大小上限和 newer-version 拒绝。
- 每个 `N -> N+1` migrator 的确定性、幂等开关和迁移后领域不变量。

### 真实文件系统集成测试

- 使用仓库外观无关的真实临时项目目录，不 mock `fs` 的正常路径。
- 新建、关闭、重开；中文、空格、长路径（含超过 260 字符的完整路径）和大小写路径。
- 同目录 temp + sync + rename 后，反复读取只能观察完整旧 head 或完整新 head。
- 保持目标文件句柄制造 Windows sharing violation，验证仅指定错误重试且耗尽不删除旧 head。
- 只读目录、缺失父目录、`ENOSPC` 故障注入、hash 翻转、截断 JSON、缺文件和额外孤儿。
- 创建 junction/symlink 指向项目外，验证拒绝越界。
- 关闭项目后复制到不同盘符/目录再打开，所有 ID、版本、批注、Prompt、任务、检索和导出记录一致，认证和绝对路径扫描为零。

### 多进程和崩溃恢复测试

- `child_process` 启动两个真实 Node 进程竞争同一 lock，只有一个成功。
- heartbeat 新鲜、陈旧、PID 复用假象、系统暂停后恢复、锁目录被外部替换。
- 对崩溃点矩阵的每个屏障启动子进程并强制终止，再用新进程打开；不能只用异常模拟跳过 OS 句柄关闭行为。
- commit 后响应前终止，再以同一 transactionId 重试，只得到原提交，不产生第二版本。
- 构造两个有效直接后继，必须返回 ambiguous，不能按时间选择。

### 迁移和兼容测试

- 保存每个历史 Schema 的最小 fixture，逐版本迁移到当前版本。
- 中间 migrator 抛错、磁盘写满、锁丢失时旧 head 仍可验证。
- 当前 App 打开 newer storage/schema 明确失败且不修改任何字节。
- migration commit 后 head 前崩溃，重开只前滚一次。

文件集成测试应在 Windows 10/11 x64 实际运行；Linux CI 的 rename/权限结果不能代替 Windows 验收。

## 进入 coding agent 的范围

在业务 Schema 审查明确 storage envelope、ID/ref 类型和 domain 验证入口后，批准 coding agent：

- 在 `packages/project` 内实现标准库原子文件辅助、路径守卫、锁租约、事务提交、恢复编排和迁移注册表；
- 直接复用精确 Zod 4.4.3，并按 monorepo 规则声明依赖；
- 建立 Node/Vitest 单元测试、真实临时目录集成测试和子进程崩溃 fixture；
- 先实现一个最小 genesis/create/open/update 流程证明协议，再接入版本、批注和任务实体；
- 将故障注入限制在测试 adapter/barrier，不让生产接口接受任意文件系统实现或任意路径。

暂缓或禁止：

- SQLite、LevelDB、原生锁、`write-file-atomic`、`proper-lockfile`、`atomically` 及其他新持久化依赖；
- 多写者合并、在线复制快照、云同步冲突解决、自动备份和垃圾回收；
- 在 renderer/preload 暴露路径、文件名、通用 read/write 或恢复清单；
- 自动抢新鲜锁、自动选择分叉 commit、自动删除无法证明来源的文件；
- 任何旧 `news/outputs` 导入。

退出条件：崩溃点矩阵、双进程锁、Windows 分享冲突、路径越界、项目关闭后跨位置复制、损坏检测和逐版本迁移测试全部通过；独立 review agent 再检查实现后，项目存储才能作为 Electron IPC 和完整业务流程的依赖。

## 参考资料

- Node.js 24 File system API：`FileHandle.sync()`、`fsPromises.open()`、`fsPromises.rename()`、`fsPromises.realpath()`。
  https://nodejs.org/docs/latest-v24.x/api/fs.html
- Node.js Path API：`path.resolve()`、`path.relative()`、`path.toNamespacedPath()`。
  https://nodejs.org/docs/latest-v24.x/api/path.html
- npm `write-file-atomic`：单文件 temp + fsync + rename 与同进程队列实现。
  https://github.com/npm/write-file-atomic
- `proper-lockfile`：原子 mkdir、mtime precision、heartbeat 和 compromised lock 模式。
  https://github.com/moxystudio/node-proper-lockfile
- `atomically`：带 retry 的单文件原子写候选。
  https://github.com/fabiospampinato/atomically

## 最终批准结论

在“不新增存储依赖、单写者、静止复制、能力探测目录、commit 清单为提交点、标准库断电保证不夸大”的边界内，批准 `packages/project` 进入实现。若主 agent 不接受任意目录和实时复制的上述解释，应暂停 coding，而不是让实现用日志文案掩盖无法兑现的平台保证。
