# Stage 4 DeepSeek 客户端与任务执行独立实现后审查

日期：2026-08-09

状态：最终独立复审通过。Stage 4 的阻断项已全部关闭，批准提交主 agent 进行阶段验收并作为 Stage 5 的依赖。

## 2026-08-09 最终独立复审

### 已关闭：preparing 提交期间立即取消不再启动 worker

统一 `arbitrateTask(save/cancel/timeout)`、异步 `cancel()` 和 host 串行 executor 已正确消除上一轮 decision probe 竞态。真实 domain/project fixture 的 `transition`、`fail`、`arbitrateTask` 共用同一串行队列；save/cancel/timeout 以谁先成功持久化为 winner，API 返回、outcome 和磁盘状态一致。

修复前，`execute()` 返回后立即调用 `cancel()` 时存在一个请求启动窗口：

1. coordinator 已调用并等待 `raw.port.transition('preparing')`；
2. `cancel()` 创建 terminal command，它正确排在 preparing 持久化之后；此时 `workerRun` 尚未赋值，`packages/ai/src/execution.ts:193` 无法向 worker 发送 cancel；
3. preparing 提交完成后，`packages/ai/src/execution.ts:211-218` 只检查 `isFinished()`，没有检查/等待已存在的 `terminalCommand`，因此继续设置 timer 并启动 worker；
4. cancel 随后持久化并返回 `accepted`，outcome 为 cancelled，但 worker 已经启动，真实 worker 可在 shutdown 前进入 `fetch`。

无文件诊断使用延迟 preparing 的串行 port 和计数 runner，稳定得到：

```text
cancelResult= accepted
outcome= cancelled persisted= cancelled workerStarts= 1
```

这会让用户在应用已接受取消后仍可能产生一次网络请求或计费，与取消语义和最低暴露原则冲突。

最终实现已在 `transition('preparing')` 成功后、设置 deadline timer 和调用 `runner.run` 前检查并 await 已存在的 `terminalCommand`，随后直接 return。新增共享 host 串行队列与 preparing barrier 测试，断言 `cancel()` 返回 accepted、outcome/disk 均 cancelled、runner starts 为 0、无 requesting/processing。

同一无文件诊断复现当前结果为：

```text
cancelResult= accepted
outcome= cancelled persisted= cancelled workerStarts= 0
```

该项通过。

### 已关闭：统一持久化仲裁

- `decisionProbe` 已删除；`TaskExecutionPort.arbitrateTask` 统一接收 save/cancel/timeout；
- `cancel()` 已异步化，只有 cancel 持久化获胜才返回 accepted；save 已持久化时返回 savingOrFinished；
- 测试覆盖 terminal 在 save 到达项目锁前获胜、save 与 cancel 同时排在锁后时按队列顺序获胜、save 已持久化后的取消；
- domain/project fixture 从磁盘重新读取 task，并在同一 serial executor 内提交 winner，避免内存 winner 与磁盘状态分离。

该项通过。

### 已关闭：补充内容拒绝规则

`validateNewsContent` 已拒绝“无法根据现有信息生成新闻稿”“无法撰写新闻稿”“审稿意见如下”“以下为问题清单”，并保留“问题清单制度”“分析如下案例”“Prompt 工程”“信息补充机制”等合法关键词正例。项目失败矩阵包含这些候选且断言不进入 save arbitration、版本/hash 不变。

该项通过。

### 最终验证

- 定向复现：immediate cancel 的 worker start 计数由修复前的 1 降为 0；取消返回、outcome 和持久化状态均为 cancelled。
- 定向测试：6 个测试文件、79 项测试全部通过。
- `pnpm verify`：format、lint、全仓 typecheck、13 个 unit 文件共 176 项测试、1 项 component 测试及 Electron main/preload/renderer 生产构建全部通过。
- 最终 `pnpm format:check` 通过。

未发现剩余阻断级行为、安全、竞态、worker 生命周期或失败造版问题。Stage 4 独立 post-review 批准。

## 2026-08-09 修复后复审

以下记录早于本次最终独立复审，仅作为审计历史，不代表当前实现状态。

coding agent 已针对首次审查的 3 个 P1 和 2 个 P2 修改实现和测试。本节记录当前结论；下文首次 Findings 保留为审计历史，不再代表每项都未修复。

### 仍阻断：[P1] `decision()` 返回 continue 后到持久化成功前仍可出现“取消已接受但最终 saving”

当前 `arbitrateSaving` 比原 `prepareSaving` 更接近正确边界：`packages/ai/src/execution.ts:256-262` 把动态 `decision` probe 交给 host，且 `packages/ai/src/execution.ts:297-313` 在 `arbitratingSaving` 期间允许登记 cancel/deadline。新增 barrier 测试也证明，在 host 调用 probe **之前**发生的取消或超时会由 port 原子持久化为 terminal。

但是接口和 coordinator 没有封闭 probe 返回 `continue` 之后的窗口：

1. host 调用 `input.decision()` 得到 `continue`；
2. host 等待项目临时文件、落盘同步、原子替换等异步提交；
3. 提交完成前用户调用 `cancel()`，coordinator 返回 `accepted` 并把 intent 设为 `cancelled`；
4. host 返回 `savingCommitted`；
5. `packages/ai/src/execution.ts:267-272` 不再复查 intent，最终返回 `saving`。

`packages/ai/src/integration.test.ts:239-273` 正是先 probe、后 `await commitUpdate`；真实项目 port 因而存在该窗口。`packages/ai/src/execution.test.ts:178-245` 的两个 barrier 都放在 probe 之前，未覆盖 probe 已返回 continue、commit 尚未完成的顺序。

这仍违反 `0007` 的用户可观察契约：取消若返回 `accepted`，最终不能静默保存；若 saving 已赢，取消必须返回 `savingOrFinished`。修复不能只是成功返回后再次检查 intent，因为任务已经持久化为 saving，领域状态机不能再转 cancelled。

验收条件：host 与 coordinator 必须共享一个线性化点，并保证以下二者之一：

- cancel/deadline 在线性化点前登记，则 port 原子持久化 cancelled/timedOut，绝不写 saving；
- saving 在线性化点获胜，则从该点开始 cancel 返回 `savingOrFinished`，不能返回 `accepted`。

建议把 `cancel()` 改为异步命令，并让 cancel、deadline 和 saving candidate 都提交到同一个 host 串行端口，例如 `arbitrateTask({ kind: 'cancel' | 'timeout' | 'save', ... })`。host 在项目单写者队列中检查磁盘当前状态并执行一次原子状态提交；谁先成功持久化 terminal/saving 谁获胜，后到命令只读取并返回既有 winner。coordinator 根据持久化结果返回 `accepted/cancelled` 或 `savingOrFinished`。不要继续把可变 `decisionProbe` 跨 `await` 传给 host，因为它无法把内存 intent 与异步磁盘 commit 组成单一线性化操作。

需要新增以下 barrier 测试：save 已入 host 队列但未持久化时 cancel 先提交；cancel 已入队时 save 后提交；save 已成功持久化后 cancel；以及两者同时等待项目锁。每项都断言 API 返回值、coordinator outcome 和磁盘 task 状态一致。

### 仍阻断：[P1] 内容验收仍接受明显的“无法生成/审稿意见如下”输出

`packages/domain/src/content-validation.ts` 已新增纯领域校验，并正确覆盖空白、明确问题清单标题、部分内部说明、Prompt 标签、Markdown fence 和待补充占位；`ContentAcceptancePort` 也确保验收发生在 saving arbitration 前。该架构边界正确。

但当前规则仍会把以下明显不是新闻稿正文的输出判为 accepted：

```text
无法根据现有信息生成新闻稿，请提供活动地点。
审稿意见如下：地点信息缺失。
以下为问题清单：地点、时间。
```

原因是 `forbiddenSection` 只接受固定标题后立即出现冒号/行尾，`internalWrapper` 只覆盖少量开头句式。现有正反例没有覆盖“无法生成/无法撰写”、`审稿意见如下`、`以下为问题清单` 等常见非正文包装。

验收条件：扩展保守的行首/首段结构规则并添加上述反例，同时保留当前“问题清单制度”“分析如下案例”“Prompt 工程”“信息补充机制”等正例，避免退化为宽泛关键词封禁。无效候选必须得到 `CONTENT_INVALID`，不得调用 `arbitrateSaving`，项目版本/hash 保持不变。

### 已关闭：凭据预检

- `packages/ai/src/execution.ts:105-112` 在 coordinator 激活或 spawn worker 前拒绝空、纯空白和超长凭据；
- `packages/ai/src/worker.ts:57-75` 再次验证完整 start command；
- 新测试断言 worker `starts === 0`，真实 runner 也在 spawn 前同步拒绝。

该项通过。

### 已关闭：malformed/unowned worker event

`packages/ai/src/worker.ts:110-123` 对 Schema 非法事件或错误 taskId 立即以 `PROTOCOL_INVALID` settle，不再等待 deadline。真实 worker fixture 已覆盖 unknown type、extra field、wrong taskId 和 forged terminal。

该项通过。

### 已关闭：worker shutdown 和 grace timer

`NodeWorkerRunner` 当前顺序为：terminal event -> `terminateOnce()` -> worker exit/termination 完成 -> resolve/reject `result`。`shutdown()` 使用单一缓存 Promise、单一局部 grace timer，worker 先退出时清理 timer，grace 获胜时只调用幂等 `terminateOnce()`。coordinator 在所有 outcome 前 await shutdown。

真实 worker 测试覆盖正常完成、失败、主动取消、异常、非零/零退出、忽略取消后的强制 terminate，以及重复 `shutdown()` 返回同一 Promise。未发现新的 handle 或凭据驻留问题。

该项通过。

### 已关闭：原子 terminal 持久化责任与项目失败矩阵

当 `arbitrateSaving` 返回 `cancelled/timedOut` 时，coordinator 不再调用 `port.fail`；port 必须已经在同一受序列化操作中持久化 terminal。`packages/ai/src/integration.test.ts:239-273` 对该契约给出了实际 domain/project port，controlled cancel/timeout 测试验证 terminal 已落盘后 outcome 才完成。

项目集成矩阵现覆盖 401、402、429、500、503、网络、协议、空响应、内容无效、worker interruption、cancel 和 timeout，并逐项断言版本数量、`latestVersionId` 和原正文 hash 不变。该项通过。

### 复审验证

已执行：

```text
pnpm exec vitest run packages/ai/src packages/domain/src/content-validation.test.ts --reporter=dot
```

结果：6 个测试文件、72 个测试全部通过。通过说明新增行为可重复，但上述两个未覆盖窗口/反例仍由当前实现直接导出，因此 Stage 4 暂不批准。

随后执行完整 `pnpm verify`：format、lint、typecheck、169 个单元测试、1 个组件测试和生产构建全部通过。全量绿色不改变上述行为审查结论。

## 审查范围

本次完整复核了：

- `AGENTS.md`、`GOAL.md`、`IMPLEMENTATION_PLAN.md`；
- `docs/architecture/0007-deepseek-task-execution-review.md`；
- `packages/ai` 的 contract、DeepSeek adapter、transport、execution coordinator、worker 及全部测试；
- `packages/shared` 的安全错误 Schema 与 `INSUFFICIENT_BALANCE` 变更；
- `packages/domain` 的新任务默认模型、历史模型可读边界、任务状态机和成功版本事务；
- Stage 4 的 domain/project 集成测试。

审查未修改实现代码，也未读取或写入凭据，未调用真实 DeepSeek 服务，未修改 `<legacy-news-root>`。

## Findings

### [P1] `processing -> saving` 尚未成功提交时已关闭取消和 deadline

证据：

- `packages/ai/src/execution.ts:167-170`：deadline callback 在 `committingSaving` 阶段直接退出；
- `packages/ai/src/execution.ts:210-212`：调用 `prepareSaving` 前先把内存 phase 改为 `committingSaving`；
- `packages/ai/src/execution.ts:248-250`：同一阶段的取消直接返回 `savingOrFinished`；
- `packages/ai/src/execution.test.ts:159-185`：现有测试把“`prepareSaving` Promise 尚未完成时拒绝取消”固化成了预期行为。

这与 `0007` 的明确边界冲突：只有复查取消意图和单调 deadline，并且**成功提交** `processing -> saving` 后，才能关闭取消。当前如果项目提交因磁盘、锁或 I/O 长时间挂起，用户取消和绝对 deadline 都不会获胜；如果提交最后失败，系统此前仍错误地告诉用户任务已经进入保存阶段。

修复要求：重新定义 host/coordinator 的串行裁决接口，使“检查 intent/deadline + 提交 saving + 关闭取消”形成可证明的单一裁决。不能只删除 `committingSaving` 判断，因为提交成功后再把任务改成 cancelled 会违反领域状态机。建议由受序列化保护的 host port 提供原子裁决操作，返回 `savingCommitted | cancelled | timedOut | conflict`；coordinator 依据结果收口。补充显式 barrier 测试，覆盖 cancel 和 deadline 分别发生在提交开始后、提交真正成功前的情形。

### [P1] 空 API Key 在真实 worker 路径中被误报为超时

证据：

- `packages/ai/src/execution.ts:75-94`：coordinator 校验 input 和 timeout，但不校验凭据是否存在或符合 worker contract；
- `packages/ai/src/contracts.ts:57-64`：worker start 命令要求 `apiKey` 长度至少为 1、至多为 4096；
- `packages/ai/src/worker-entry.ts:15-24`：首条命令校验失败且 `active` 尚不存在时，worker 不回送任何失败事件；
- `packages/ai/src/deepseek.test.ts:204-234`：缺凭据只测试了直接调用 `DeepSeekClient`，没有覆盖 coordinator + 真实 worker；
- `packages/ai/src/execution.test.ts:256-319`：真实 worker 测试全部使用非空凭据。

因此 `AiTaskCoordinator.execute({ apiKey: '' })` 会启动 worker，worker 静默丢弃 start 命令，任务直到 deadline 才成为 `REQUEST_TIMEOUT`。超长凭据也有相同问题。它违反本地无凭据必须立即映射 `AUTH_REQUIRED` 的契约，并造成无意义的 worker 驻留。

修复要求：在受信 host/coordinator 启动 worker 前校验凭据，空白凭据安全失败为 `AUTH_REQUIRED`，不启动 worker、不发网络请求。worker runner 还应在 spawn/postMessage 前验证完整 start command；worker 收到不可归属的非法首条命令时应安全退出，不能永久等待。增加真实 worker 的空、纯空白、超长凭据测试，并断言无请求、无超时误报、无遗留 handle。

### [P1] 任意非空模型输出都能成为成功版本，缺少已批准的内容验收

证据：

- `packages/ai/src/deepseek.ts:140-156`：`stop` 结果仅 trim 并检查非空，随后直接产生成功候选；
- `packages/ai/src/execution.ts:210-216`：该候选未经产品内容校验直接交给 `prepareSaving`；
- `packages/domain/src/commands.ts:527-530`：成功事务也只拒绝空白正文；
- `docs/baseline/FUNCTION_MATRIX.md` 的 F07、A07 和 `0007` 的“完成原因和空响应规则”要求拒绝问题清单、内部说明、CoT/分析包装和未清理占位内容。

目前诸如“问题清单：地点待补充”、纯解释、代码围栏包裹的内部输出，只要非空就能进入 `saving` 并最终创建成功版本。这直接破坏“失败/无效结果不造版”和干净 DOCX 的上游保证。

修复要求：在 saving 裁决前接入独立、确定性的内容验收 port/领域函数，复用阶段 1 黄金规则；adapter 仍只负责 wire 解析。至少覆盖正常新闻稿、纯问题清单、解释/分析包装、Prompt 标签回显、代码围栏、待补充占位、只有 `reasoning_content`、清理后为空。无效结果映射 `CONTENT_INVALID` 或 `EMPTY_RESPONSE`，且不得进入 saving。

### [P2] worker 的非法事件或错误 taskId 被静默忽略，任务会被误判为超时

`packages/ai/src/worker.ts:47-50` 对 Schema 非法事件、错误 taskId 都直接 `return`。一任务一 worker 的设计下，这些消息不能属于别的合法任务；静默忽略会把 worker 协议损坏掩盖成用户可重试的 `REQUEST_TIMEOUT`，并延长 worker/key 的驻留时间。

修复要求：首个非法或不可归属事件应使 run 以安全的 `TASK_INTERRUPTED` 或 `PROTOCOL_INVALID` 失败并终止 worker。增加真实 worker fixture，分别发送未知事件、额外字段、错误 taskId 和伪造 terminal，断言立即失败而不是等待 deadline。

### [P2] worker termination 和 grace timer 没有形成可等待、可清理的生命周期

证据：

- `packages/ai/src/execution.ts:120-127`：grace timer 的 handle 不保存，无法在 worker 已退出时清理；
- `packages/ai/src/execution.ts:136` 与 `packages/ai/src/execution.ts:253`：一次取消会先在 `cancel()` 安排 grace terminate，随后 `finish(cancelled)` 再安排一次；
- `packages/ai/src/execution.ts:123`、`214`：立即 termination 的 Promise 被丢弃，outcome 可在真实 worker 完全退出前完成；
- `packages/ai/src/execution.test.ts:86-109` 只统计 `terminate()` 被调用，未证明真实 worker 已退出；取消测试也未检查 coordinator 的 grace 强制终止和计时器回收。

短 grace timer 最终会自行释放，但当前协议无法保证“terminal outcome 完成时 worker 已清理”，也无法处理 termination rejection；重复 timer 会制造多次 terminate。Stage 4 的独立 worker 含一次性 API Key，此生命周期应有明确完成点。

修复要求：保存并幂等管理唯一 grace handle；worker result/exit 后清理它；termination 只发起一次并处理 Promise；定义 outcome 与 worker shutdown 的先后契约。用真实 worker 覆盖正常、失败、取消后主动退出、忽略取消后 grace 强制 terminate，并在测试结束断言无遗留 handle。

## 测试门禁缺口

现有测试证明了固定 endpoint、精确 reasoning 映射、`stream:false`、主体响应 Schema、主要 HTTP 错误映射、成功 8 MiB 上限和“不自动重试”。以下 `0007` 明确要求仍未覆盖：

- error body 的 64 KiB 上限；错误 content-type、截断 JSON、延迟 headers、延迟/分块 body 与绝对 deadline 的组合；
- 真实 coordinator + transport/worker 的请求前取消、等 headers 取消、读 body 取消和 grace 强制 terminate；
- response/cancel/timeout 三方顺序的完整 barrier 矩阵，尤其 saving 提交尚未成功的窗口；
- 401、402、429、500、503、网络中断、协议错误、空/无效正文、取消、超时、worker crash 的逐项 domain/project 集成断言；
- 每条失败链均验证 `versions`、`latestVersionId` 和原正文 hash 不变；
- worker 非法消息与真实进程 handle 清理。

`packages/ai/src/integration.test.ts` 当前只证明一条成功链和一条 402 失败链。单元层的错误映射测试不能替代失败不造版的项目事务集成门禁。

## 已确认正确的边界

- 新任务默认模型已改为 `deepseek-v4-pro`；领域 Schema 仍允许读取历史模型字符串，AI 发新请求时以固定 allowlist 拒绝 `deepseek-chat`；
- `INSUFFICIENT_BALANCE` 已进入严格共享错误 Schema，HTTP 402 映射准确；
- endpoint、method、headers 和 request body 字段固定，redirect 被禁止，没有公开 base URL/header/provider registry；
- reasoning 映射与 `max_tokens = min(32768, maxWords * 2 + 2048)` 符合批准契约；
- 成功/错误 body 在解析前采用 8 MiB/64 KiB 实现上限，JSON 使用 fatal UTF-8，未知响应字段被丢弃，`reasoning_content` 不进入结果；
- 429/500/503 与网络错误没有自动重试；
- packages/ai 不直接创建 Version，也不直接读写项目路径；现有成功事务仍拥有版本创建；
- 现有安全错误文案未发现 Prompt、响应正文、Authorization、stack 或绝对路径泄漏。

## 验证结果

已执行：

```text
pnpm exec vitest run packages/ai/src --reporter=verbose
```

结果：5 个测试文件、42 个测试全部通过。该结果说明现有断言稳定，但其中 saving barrier 测试固化了与 `0007` 相反的取消边界，且上述门禁缺口尚未被测试覆盖。

## 审查结论

Stage 4 暂不批准成为 Stage 5 的可靠依赖。coding agent 应仅修复以上 Stage 4 契约问题和测试，不扩展到 Electron IPC、凭据落盘或 UI。修复后需再次独立 post-review，并至少通过 scoped AI tests、完整 `pnpm verify` 和 worker 无遗留 handle 验收。
