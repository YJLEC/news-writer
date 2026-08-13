# 0014 Stage 6 项目锁恢复独立复审

- 状态：批准 renderer 使用
- 审查日期：2026-08-10
- 审查角色：独立 lock recovery post-review agent
- 依据：`AGENTS.md`、`0009-electron-ipc-credentials-review.md`、`0010-electron-ipc-credentials-post-review.md`、`0011-monaco-workspace-review.md`
- 范围：`packages/project` observed lock API、`packages/shared` IPC 契约、`ProjectService` pending registry、Electron main/preload 接线及对应测试
- 不在范围：renderer 交互实现、DOCX、知识库、产品代码修改

## 结论

没有发现 blocker。实现满足编码前冻结的显式锁恢复边界，可批准 renderer 使用 `projects.openWithDialog` 返回的恢复描述符，并在用户确认后调用固定的 `projects.recoverOpen` 方法。

普通打开不会自动破锁。只有可严格解析且已过期的 lock owner 才会产生确认描述符；renderer 不提供项目路径，也不能提交 observed lock id。主进程保存 canonical root 和 observed instance id，并把二者绑定到短期、owner-scoped 的一次性 token。恢复成功后，项目仍须完整通过打开、凭据/项目内容扫描、任务中断恢复、再次扫描和 session ownership 注册，之后才向 renderer 暴露 `ProjectViewDto`。

## 逐项审查结果

### Project observed lock API

- `ProjectLock.acquire` 只为已解析的 stale owner 附带 `observedLockInstanceId`；fresh lock 返回 `PROJECT_LOCKED`，不进入恢复流程。
- `recoverProjectLock(root, observedInstanceId, true)` 重新 canonicalize root，并把 observed id 交给 `recoverStaleProjectLock` 的严格 `instanceIdSchema`。
- 底层恢复在移动锁目录前两次读取 owner，并校验 instance、PID、process start、heartbeat 以及目录 device/inode/mtime；fresh、进程仍存活、owner 或目录身份变化均拒绝。
- 恢复调用显式传入 observed instance id 和字面量 `true`。IPC schema 同时将 `confirmed` 限定为 `z.literal(true)`，`false` 或缺失确认无法进入 main handler。

### Strict descriptor、request 和 channel

- `projectLockRecoveryDescriptorSchema` 是 strict plain-object schema，仅包含 UUID `recoveryToken` 和 UUID `observedInstanceId`；不包含路径、PID、用户名、时间、凭据、锁文件内容或其他 secret。
- `recoverProjectOpenDtoSchema` 仅包含 UUID token 与 `confirmed: true`，renderer 不能回传路径或替换 observed id。
- `projectsRecoverOpen` 是固定 `nw:v1:projects:recover-open` channel，进入 `IPC_INVOKE_CONTRACTS`；main 和 preload 分别校验请求和完整结果 envelope。
- preload 只暴露命名方法 `projects.recoverOpen`，没有通用 `invoke`、动态 channel、文件系统或 Node 能力。
- IPC 正反 schema 测试覆盖成功描述符、未知字段、伪造 token 和 `confirmed:false` 拒绝；Electron E2E 的 bridge key 快照包含且只包含批准的方法。

### Pending recovery registry

- token 由 `randomUUID()` 生成，pending record 只存在 main 内存，绑定 `ownerId`、canonical root、observed instance id 和到期时间。
- TTL 为两分钟；timer 主动删除，恢复入口也按当前时间再次检查，避免事件循环延迟绕过到期限制。
- 新的 open attempt 在显示 dialog 前使该 owner 之前的 token 失效；窗口关闭、renderer process gone 和 app shutdown 同样清空 pending recovery。
- 伪造 token 和跨 owner token 返回固定 `IPC_SENDER_REJECTED`，且跨 owner 尝试不会消费合法 owner 的 token。
- 合法 token 在任何磁盘恢复动作之前删除。因此重放被拒绝；同一 token 的两个并发确认经过 shared linearization gate 后只能一个成功。
- observed lock 实例发生变化时，project 层以 `PROJECT_LOCKED` 安全拒绝；token 已消费，用户必须重新打开并重新观察，不会沿用旧确认。
- 同一 canonical root 已在进程内打开时拒绝恢复。恢复、open、检查和 register 全部位于 main-owned shared gate 内，不会与 create/open、项目 mutation、任务提交或 credential 替换交错。

### 恢复后的安全与所有权

- `recoverOpen` 低层恢复后重新调用正式 `openProject`，没有直接构造或复用未经验证的 aggregate。
- `#finishOpen` 在注册 session 前先执行当前 configured key 与公共 secret scanner，再把遗留的 `queued/preparing/requesting/processing/saving` 任务原子收口为 `failed + TASK_INTERRUPTED`，然后再次扫描。
- 只有上述步骤全部成功才生成新的 opaque session UUID，并把 canonical root、`ProjectSession` 和 owner webContents id 注册为 owner session。
- 任一步失败都会关闭新取得的 project session/lock，且不会向 renderer 暴露 session capability。
- shared gate 延续 `0010` 的凭据/项目线性化保证；恢复期间不能插入候选 API Key 持久化或其他项目写入。

### 错误脱敏

- `ProjectError.observedLockInstanceId` 只供 main 在首次 open failure 中建立 pending recovery；`ProjectError.toSafeError` 不序列化该字段。
- IPC failure envelope 只允许 strict `SafeAppError` 字段。未知异常映射为固定 `UNKNOWN` 和随机 diagnostic id，原始 message、stack、路径和 payload 不跨 IPC。
- 恢复描述符有意显示 observed instance UUID，以满足 `0011` 的显式确认要求；它不是错误 metadata，也不包含可定位项目或锁 owner 的信息。

## 测试证据

定向执行：

```text
packages/project/src/repository.test.ts
packages/shared/src/ipc.test.ts
apps/desktop/main/project-service.test.ts
apps/desktop/main/ipc-core.test.ts
```

结果：4 个测试文件、84 个测试全部通过。定向用例覆盖 stale/fresh lock、显式确认、伪造与跨 owner token、合法 token 不被跨 owner 消费、重放、new-open invalidation、owner disposal、TTL、锁实例替换、并发双确认、strict IPC 和错误内容脱敏。

全量 `pnpm verify` 通过：

- format、lint、typecheck、build 全部通过；
- unit：24 个文件、306 个测试通过；
- component：1 个文件、1 个测试通过；
- Electron renderer/main/preload 生产构建成功。

## 剩余风险与 renderer 使用约束

当前自动化没有通过真实 Electron dialog 完成一次 stale-lock 恢复的端到端点击流程；main service 的真实文件系统集成测试、shared/preload 双向 schema 和 Electron bridge 快照已经覆盖安全边界，因此这不是 renderer 编码 blocker。Stage 6 renderer E2E 应补充一次“打开 -> 显示 observed instance -> 明确确认 -> 恢复进入 workspace”的用户流程，并验证取消确认不会调用恢复 channel。

renderer 必须把恢复描述符视为短期能力：只显示 observed instance id，不持久化 token，不写入日志、URL 或浏览器存储；每次失败、取消或重新打开后丢弃旧 token。UI 不得提供路径输入、自动确认、自动重试或绕过 `confirmed:true` 的入口。

## 最终批准

Stage 6 锁恢复实现符合 `0009`、`0010` 和 `0011` 冻结的架构、安全与恢复语义。批准主 agent 将该 API 交给 renderer coding agent 集成。
