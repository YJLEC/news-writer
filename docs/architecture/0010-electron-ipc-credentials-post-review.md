# Stage 5 Electron IPC、凭据与任务 Host 独立实现后审查

日期：2026-08-09

状态：最终独立复审批准。主组合根的单例 gate、权威 refresh 与全部顺序入口已闭合，本文历史上的 findings 已全部关闭；Stage 5 可作为 Stage 6 的依赖。

## 2026-08-09 最后 P1 修复后独立复审

### 结论：批准，无剩余 blocker

上一轮 completion post-head 异常与 auth 替换的线性化 P1 已关闭。`ProjectService.setCredentialIfProjectsSafe` 在同一次 global gate 占用内，对每个已打开 session 先 `await project.refresh()` 完成权威 HEAD 恢复，再扫描 aggregate 和全部 text refs，最后才调用 auth persist。任一 session refresh 失败都会在 persist 前退出，不存在部分 auth 写入。

该顺序与主组合根共享的单例 `SerialLinearizationGate` 共同保证：

- mutation 在 `afterHeadReplace` 丢失响应后，排队的 candidate set 会先 refresh 到已提交的新纪要，命中候选 key 并在 auth persist 前拒绝；
- completion 在 `afterHeadReplace` 丢失响应后，排队的 candidate set 同样先 refresh 到已提交的新正文并拒绝；随后 completion reconcile 识别已成功事务，保持 succeeded 且只有一个版本；
- 权威 refresh 失败时候选 key 不会持久化；
- 原有 mutation/set 两种顺序、create/open/register/close、task queue/transition/arbitrate/completion/reconcile、processing 结果包含候选 key，以及 succeeded/failed/cancelled/timedOut 四终态 event 中立即重试的覆盖仍然通过。

未发现新的反向锁顺序：TaskHost 仍为 `hostSerial -> shared gate -> ProjectSession.commit`，ProjectService 为 `shared gate -> ProjectSession` 队列；不存在持有 shared gate 后等待 `hostSerial` 的路径。

### 本轮验证

定向执行：

```text
pnpm exec vitest run apps/desktop/main/project-service.test.ts apps/desktop/main/task-host.test.ts apps/desktop/main/credential-service.test.ts packages/project/src/repository.test.ts --reporter=dot
```

结果：4 个测试文件、100 项测试全部通过。

完整执行 `pnpm verify`：format、lint、全部 typecheck、22 个 unit 文件共 268 项测试、1 项 component 测试，以及 main/preload/renderer 生产构建全部通过。

以下“共享 gate 修复后最终独立复审”为上一轮审计历史；其中 completion/reconcile 窗口 P1 已由本轮权威 refresh 修复关闭，不再代表当前状态。

## 2026-08-09 共享 gate 修复后最终独立复审

### 仍阻断：[P1] completion post-head 异常与 reconcile 之间可插入候选 key 持久化

上一轮的共享线性化缺口已基本关闭：`apps/desktop/main/index.ts` 在主组合根只创建一个 `SerialLinearizationGate`，并将同一实例注入 `ProjectService` 和 `TaskHostService`。create/open/register/close/closeAll、所有 `ProjectService` mutation 与 open recovery，以及 TaskHost queue/transition/arbitrate/completion/reconcile 都进入该 gate。TaskHost 的锁顺序为 `hostSerial -> shared gate -> ProjectSession.commit`；未发现持有 shared gate 后反向等待 `hostSerial` 的路径。新增测试已覆盖 mutation/set 两种先后顺序、create/open/register/close 边界、task queue、processing 期间候选 key 切换后 worker 返回含该候选值、普通 completion 与 set 的竞争，以及 succeeded/failed/cancelled/timedOut 四种终态 event 中立即重试。

但 `apps/desktop/main/task-host.ts:267-288` 仍把 completion 和它的异常 reconcile 分成两次 shared-gate 申请：

1. `#complete` 在 gate 内调用 `ProjectSession.commit`；
2. commit 在磁盘 HEAD 已原子替换后于 `afterHeadReplace` 故障点抛错，此时新版本已持久化，但 `ProjectSession` 内存聚合仍停留在 saving；
3. `#complete` 退出并释放 gate，`.catch(...)` 随后才调用 `#reconcileCompletion` 重新申请 gate；
4. 如果在 completion 期间已排队的 `setCredentialIfProjectsSafe(candidate)` 先取得 gate，它会通过 `ProjectService.#assertProjectSafe -> project.read()` 扫描尚未 refresh 的 saving 聚合，看不到磁盘 HEAD 中已成功版本的正文；
5. 若该正文含 `candidate`，auth persist 可错误成功，之后 reconcile 才 refresh 出已包含当前 API Key 的项目。

这不是普通 completion 竞争测试可以覆盖的路径。`task-host.test.ts` 的 post-head 用例只验证无并发 auth set 时 refresh 不重复造版；completion/set 用例只在 `afterPrepare` 阻塞正常提交，没有组合 `afterHeadReplace` 抛错、已排队 set 和 reconcile。

修复验收：completion 提交失败后的权威 refresh/reconcile 必须在候选 key 扫描可进入前完成。可以让 completion 与它的 reconcile 共享同一次 gate 占用，或提供等价且可证明的权威状态协议。增加显式 barrier 测试：让包含候选 key 的成功版本在 `afterHeadReplace` 抛错，在 completion 释放 gate 时使 auth set 与 reconcile 竞争；断言 auth set 不得持久化、项目最终只有一个 succeeded 版本，且 revision/head/artifacts 与重开结果一致。

### 本轮验证

定向执行：

```text
pnpm exec vitest run apps/desktop/main/project-service.test.ts apps/desktop/main/task-host.test.ts apps/desktop/main/credential-service.test.ts packages/project/src/repository.test.ts --reporter=dot
```

结果：4 个测试文件、98 项测试全部通过。该结果确认已有共享 gate 顺序、项目并发边界、任务终态重试与常规 completion 竞争保持稳定，但没有执行上述 post-head/set 组合复现，因此不改变“不批准”结论。

以下“第二次修复后独立复审”为上一轮审计历史；其中“没有共享 gate”的 P1 已关闭，当前只以上述 completion/reconcile 窗口为阻断。

## 2026-08-09 第二次修复后独立复审

### 仍阻断：[P1] 候选 key 扫描与 auth 持久化没有和项目写入形成共同线性化点

上一轮要求的顺序边界已经实现：

- `ProjectService` 在 create 和所有 `#mutate` 前读取 configured key，并对 IPC input、next aggregate 和新增 artifacts 执行 common + exact scan；
- `setCredentialIfProjectsSafe` 在保存候选 key 前 exact 扫描全部已打开 session 的权威 aggregate 和 text refs；
- open 在 register/暴露 session 前以当前 configured key 扫描，并在失败时关闭 session/lock；
- project storage 在 hydrate/open/commit 时扫描既有与新增 metadata、records 和 text artifacts 的 common pattern。

但 `apps/desktop/main/project-service.ts:335-343` 的候选 key 流程是“遍历当前 `#sessions` -> `await persist()`”，它与 `createWithDialog`、`openWithDialog`、`#mutate` 以及 `TaskHostService` 的 queue/transition/arbitrate/completion/reconcile 直接 commit 没有共享串行器或其他线性化协议。并发 IPC 可以稳定形成以下非法顺序：

1. `auth.set` 用候选 `synthetic-credential` 扫描所有当前 session，结果安全；
2. 在 safeStorage 加密/原子写 `auth.json` 尚未完成时，project mutation 仍读取旧 key 或 `undefined`，把相同字符串写入纪要、批注或配置并提交；
3. auth persist 随后成功，最终 auth 和项目同时携带同一 API Key。

create/open 也有同类窗口：扫描候选 key 时新项目尚未进入 `#sessions`；create 可在读取旧 key 后完成落盘和注册，open 可在最后一次 configured-key 读取后、register 前与 auth persist 交错。顺序检查都成功并不能维持跨两个持久化域的不变量。

修复验收：候选 key 的“扫描所有 session + auth persist”必须与所有 create/open/register、ProjectService mutation/recovery 以及 TaskHost queue/transition/arbitrate/completion/reconcile 的直接 project commit 共用一个 main-owned 全局线性化 gate，或提供等价且可证明的协议。TaskHost 不能绕过 gate 直接调用 `ProjectSession.commit`。不得用无界锁或只依赖 renderer 禁用按钮。增加显式 barrier 测试覆盖：

- candidate scan 后、auth 原子替换前并发 save/import/comment/config；
- candidate scan 时并发 create；
- open 完成 storage hydrate 但 register 前并发 auth set。
- candidate scan 后并发 task queue，以及 processing/saving/completion/reconcile commit。

每项只能得到一个符合不变量的顺序结果：若项目先写，auth set 必须安全失败且 auth 磁盘不变；若 auth 先写，项目操作必须按新 exact key 失败且 project revision/head/artifacts 不变。错误、event 和测试输出不得包含 key 或路径。正常并发不同项目 mutation 仍由现有 project 单写者保证，不得因新 gate 死锁。

### 本轮验证

定向执行：

```text
pnpm exec vitest run apps/desktop/main/project-service.test.ts apps/desktop/main/credential-service.test.ts packages/project/src/repository.test.ts packages/shared/src/index.test.ts --reporter=dot
```

结果：4 个测试文件、80 项测试全部通过。当前测试证明所有顺序入口和 project storage 纵深防御有效，但没有 scan/persist 与 project write 的 barrier 竞态，因此不改变“不批准”结论。

以下“修复后最终独立复审”记录是上一轮审计历史；其中列出的顺序入口缺口已关闭，当前只以上述并发 P1 为阻断。

## 2026-08-09 修复后最终独立复审

### 仍阻断：[P1] 当前已配置的非通用形态 API Key 仍可从非 Prompt 路径进入项目

本轮已正确把通用 scanner 提升到 `packages/shared/src/secrets.ts`，并在 `apps/desktop/main/task-host.ts:134-144` 的 Prompt 排队前执行“common pattern + 当前实际 key exact match”；`packages/ai/src/deepseek.ts:184-193` 复用同一 scanner 做发送前纵深防御。`packages/project/src/layout.ts:40-45`、`:171-210` 也会拒绝本次 commit 新提供的 credential-shaped artifact 和生成的 record/metadata。

但项目硬边界仍未完整闭合：

- `CredentialService` 接受任意 1-4096 字符的非空 key；测试和产品路径中的 `synthetic-credential` 就不匹配 `sk-`/Bearer/common JSON pattern。
- `ProjectService` 不持有受控的凭据检测 port。`createWithDialog`、`saveMinutes`、`importMinutesWithDialog`、comment body 和项目配置等非 Prompt mutation 没有用当前已配置 key 做 exact scan。因此把 `synthetic-credential` 原样放入纪要、批注或配置，可以通过 project package 的 common scanner 并永久落盘。
- `packages/project/src/layout.ts:171-178` 只扫描本次 commit 的 supplied artifacts；`hydrateProjectState` 在 `:264-320` 加载既有 text refs 时没有 common scan。旧版本 App 已写入或外部构造且 hash/manifest 自洽的 credential-shaped text 可被打开；后续不重新提供该 artifact 的 mutation也会继续保留它。
- 当前 auth set handler 直接保存新 key，没有先用该 exact key 检查所有已打开 session。若一个尚未配置凭据的项目已包含相同非 pattern 字符串，随后把它设为 API Key，项目立即变成携带当前凭据的副本。

这仍违反“API Key 不得进入项目”和“在 Prompt/project data 中检测到凭据即硬阻断”。Prompt 主路径已修复，不能代替项目所有持久化入口的权威检查。

修复验收边界：

1. 所有 project mutation 在 commit 前扫描其全部待持久化字符串：common pattern 由 project storage 继续兜底；main 的受控项目服务还必须加入当前 configured key 的 exact scan。命中只返回固定安全错误，不回显 key、文本或路径，revision/head 和所有 records/artifacts 不变。
2. 设置或替换 API Key 前，先以候选 key exact 扫描所有已打开 session 的权威 aggregate 和全部 `ProjectSession.readText` refs；任一命中则不得写 `auth.json`。
3. 打开项目时，在 register/向 renderer 暴露 session 前，以当前 configured key exact 扫描权威 aggregate 和全部 text refs；命中则关闭 session/lock 并安全拒绝打开。
4. project storage 在 hydrate/open 时也对 metadata、records 和全部 text artifacts 执行 common scanner，commit 时保留现有 common 纵深防御；不能只扫描 supplied artifacts。
5. 增加 `synthetic-credential` 这类非 pattern exact key 的新建纪要、保存/导入纪要、批注、项目配置、Prompt、set-key-before-open、open-before-set-key 和已有 artifact 后续无 artifact mutation测试；逐项断言 auth/project 两侧都没有产生部分写入。

在没有配置 key 时，任意普通非 pattern 字符串无法被先验识别为秘密，这是合理限制；但一旦 key 已配置，或用户正在设置候选 key，上述 exact 检查必须生效。

### 已关闭：原 5 个 P1

- Prompt secret precommit：common pattern 与实际 key exact scan 均发生在 artifact/queue commit 之前；project commit 和 DeepSeek client 复用 shared scanner 做纵深防御。
- active/saving 重开恢复：project repository 先恢复权威 head/成功 successor，`ProjectService` 再在 session register 前把仍遗留的 queued/preparing/requesting/processing/saving 原子转为 failed + `TASK_INTERRUPTED`。测试覆盖五种状态、恢复失败重试和幂等二次打开；post-head 成功事务保持 succeeded 且不重复造版。
- latest/save 竞争：active task 期间切换 latest 在 main 权威 mutation 边界拒绝；项目 commit CAS 处理并发队列。completion 的 pre-commit/post-head 异常会 refresh 并 reconcile，不再静默遗留 saving。
- 有界读取 TOCTOU：auth 和纪要导入复用同一 handle 的 `fstat + limit+1` 读取，覆盖路径替换、文件增长、精确边界和失败关闭。
- shutdown watchdog：退出使用有限 watchdog；blocked transition/saving 测试证明超时时不伪造 terminal/version，正常释放后仍按持久化 winner 完成，下次打开可走上述恢复边界。

### 已关闭：原 2 个 P2

- 不支持模型在读取凭据、排队和启动 worker 前映射为固定 `IPC_PROTOCOL_INVALID`，项目配置和单次覆盖均有测试。
- sender/top-frame/dev origin、owner event 隔离、并发 start、host 失败矩阵、watchdog 和恢复 barrier 已形成新增门禁；未发现 raw error、伪造 worker event 或跨 owner event 穿透。

### 本轮验证

定向执行：

```text
pnpm exec vitest run apps/desktop/main packages/shared/src/index.test.ts packages/ai/src/deepseek.test.ts packages/project/src/repository.test.ts --reporter=dot
```

结果：11 个测试文件、146 项测试全部通过。该结果证明原 findings 的修复稳定，但现有 secret 测试只覆盖 Prompt 的 actual-key exact scan 和 project 新写入的 common pattern，未覆盖上述非 Prompt actual-key 与既有 artifact 读取路径，因此不改变剩余阻断结论。

完整 `pnpm verify` 也已通过：format、lint、全仓 typecheck、22 个 unit 文件共 250 项测试、1 项 component 测试及 main/preload/renderer 生产构建全部成功。全量绿色同样不覆盖剩余 exact-key 项目入口，故 Stage 5 仍不批准。

以下首次审查内容保留为审计历史；其中原 5 个 P1 和 2 个 P2 均已由本轮关闭，不再代表当前未修复状态。

## Findings

### [P1] 通用凭据扫描发生在 Prompt 已写入项目之后

`apps/desktop/main/task-host.ts:117-120` 在排队前只检查 Prompt 是否精确包含当前 DeepSeek API Key。`sk-...`、`Bearer ...` 等其他常见凭据形态直到 `packages/ai/src/deepseek.ts:159-191` 的 worker/客户端阶段才会被拒绝；但在此之前，`apps/desktop/main/task-host.ts:132-184` 已把 Prompt artifact、Prompt record 和 queued task 原子提交到项目。

这违反 API Key/凭据不得进入 Prompt 和项目数据的硬边界。失败请求仍会永久留下含凭据的历史 Prompt，后续项目复制、浏览和备份都会携带该秘密。

修复验收：把统一 secret-pattern scanner 提升为可复用的纯函数，并在创建任何 artifact、task 或 commit 之前同时执行“实际 key 精确匹配 + 通用凭据模式”检查。命中时返回固定安全错误，不回显命中值；磁盘 revision、Prompt/task 数量和 worker start 数均保持不变。测试至少覆盖其他 `sk-...`、`Bearer ...`、当前 key、大小写和跨多条 message。

### [P1] 进程重开不恢复遗留 active/saving task

`packages/project/src/repository.ts:907-921` 只完成项目存储/head 恢复并返回原 aggregate；`apps/desktop/main/project-service.ts:94-103` 注册该 session 时不处理 task；`apps/desktop/main/task-host.ts` 也只跟踪本进程新启动的 `#active` handle。因而崩溃后遗留的 queued/preparing/requesting/processing task 没有 worker，却仍被领域层视为 active；saving task 也没有 host 完成或失败。`queueTask` 和项目关闭会长期被阻断。

修复验收：项目打开后、向 renderer 暴露 session 前，按以下顺序在同一 `ProjectSession` 串行提交边界内恢复：

1. 先让现有 project repository 完成已发布 commit/head 的崩溃恢复，并重新读取权威 aggregate。
2. 若 `completeTaskWithVersion` 已由相同 `successTransactionId` 恢复为 succeeded，不再重复写入。
3. 若 task 仍为 saving，说明没有可恢复的成功事务；用一次原子项目 commit 将其转为 failed + `TASK_INTERRUPTED`，不得创建 Version，也不得猜测丢失的响应正文。
4. 将仍为 queued/preparing/requesting/processing 的唯一 active task 原子转为 failed + `TASK_INTERRUPTED`。
5. 重新读取并校验 aggregate 后才注册/返回 session；恢复提交失败则安全拒绝打开并保留可再次恢复的磁盘状态。

增加真实关闭/重开测试，覆盖四类 active 状态、saving 成功事务已发布、saving 尚未发布、恢复 commit 故障注入和幂等二次打开。

### [P1] 任务执行期间切换最新版可留下永久 saving task

`apps/desktop/main/project-service.ts:153-163` 的 `setLatestVersion` 不拒绝 active task。用户可在 review/revision 请求 processing 时切换 latest；随后 `apps/desktop/main/task-host.ts:324-339` 仍把任务提交为 saving，而 `packages/domain/src/commands.ts:520-525` 在成功事务中因 `latestVersionId !== expectedLatestVersionId` 拒绝完成。`apps/desktop/main/task-host.ts:235-255` 吞掉该异常并移除内存 active handle，磁盘 task 留在 saving，无法取消、关闭项目或启动下一任务。

修复验收：在进入 saving 的同一持久化仲裁中验证 task 的 parent/latest 基线仍成立；基线已改变时原子落 failed（安全错误）而不是 saving。也可在 main 权威边界禁止 active task 期间切换 latest，但不能只依赖 UI。任何 success completion 异常都不得静默留下无 host 的 saving。增加“processing 时切换 latest”“切换与 save 同时等待项目队列”“完成 commit 失败”测试，断言终态、版本数、latest 和旧正文 hash 一致。

### [P1] 凭据和纪要导入的大小限制存在 stat/read TOCTOU

`apps/desktop/main/credential-service.ts:174-178` 先对路径 `stat`，再用新的 `readFile` 调用无界读取；文件可在两次调用间被替换，因此 16 KiB 只是一项预检查，不是读取上限。`apps/desktop/main/project-service.ts:115-120` 对用户选择的纪要文件采用相同的 `stat -> readFile` 模式，1 MiB 上限也可被绕过。攻击或同步软件竞争可导致主进程读取任意大文件并造成内存/响应性问题。

修复验收：一次打开文件 handle，在同一 handle 上 `fstat` 并最多读取 `limit + 1` 字节，检测额外字节后拒绝；解析/解码也只使用该受限 buffer。关闭 handle 的失败路径必须完整。测试用替换/追加 barrier 证明路径替换和文件增长均不能越过 16 KiB/1 MiB 限制；不得把路径或内容带入错误。

### [P1] 退出流程没有有限 watchdog，可能永远阻止窗口和 App 退出

`apps/desktop/main/index.ts:184-193` 在 `before-quit` 中永久等待 `taskHost.shutdownAll()` 和 `projectService.closeAll()`；`apps/desktop/main/task-host.ts:274-280` 又永久等待 worker cancellation/outcome。实现没有 `0009` 要求的有限 shutdown watchdog，非协作 worker、卡住的项目 commit 或 I/O 可让窗口始终无法关闭。

修复验收：增加单一有限 watchdog；超时只记录 allowlisted `shutdown-watchdog` 诊断并进入可由下次启动恢复的退出路径，不伪造 cancelled/succeeded，不删除项目数据。正常 cancellation 和 saving 成功事务仍必须优先等待。用不响应 cancel 的 worker、卡住 transition 和 saving commit barrier 验证正常路径完整落盘、watchdog 路径有限返回、重开按上一 finding 收口。

### [P2] 合法可配置但不受支持的模型走 UNKNOWN 常规分支

IPC/project 配置 Schema 接受一般模型字符串；`apps/desktop/main/task-host.ts:176` 用 `deepSeekModelSchema.parse` 收紧模型，但抛出的 ZodError 最终由 `apps/desktop/main/ipc-core.ts:46-59` 映射为 `UNKNOWN`。这是用户可稳定触发的普通配置错误，不应产生 diagnostic-only 未知错误。

修复验收：在 queue 前显式安全映射为 `PROTOCOL_INVALID`/配置类安全错误，且不创建 Prompt/task、不启动 worker；覆盖项目配置和单次任务覆盖两条路径。

### [P2] Stage 5 明确要求的安全与故障矩阵尚未形成测试门禁

现有 desktop main 测试共 26 项，未直接覆盖 `isTrustedSender` 的 destroyed sender、子 frame、错误生产 URL/dev origin，也未覆盖 main event owner/session 隔离、伪造 event、通用 secret 预落盘阻断、并发 start、任务重开恢复、latest/save 竞争、auth/导入 TOCTOU、shutdown watchdog、401/402/429/500/503/网络/协议/空正文/worker crash 在 Electron host 层的不造版矩阵。E2E 的 iframe probe 只能证明当前页面的窄桥接结果，不能替代 main handler 的逐项身份测试。

修复验收：补齐 `0009`“Schema 与 handler”“路径与 session”“凭据”“task host barrier”“Electron 与打包 E2E”清单。测试必须断言 IPC 返回、event、磁盘 task、Version 数量、latest 和旧正文 hash 同时一致，不能只断言 Promise 状态。

## 已确认正确的边界

- shared 为每个固定 channel 定义 strict request/result Schema；main 在 sender 校验后解析请求并在发送前解析完整 envelope，未知异常不会把 message、stack 或绝对路径传给 renderer。
- preload 只暴露固定的分组 API，没有通用 invoke/on/send、Node、文件系统、路径或凭据能力；task event 在 listener 前再次 Schema 校验。
- session capability 由 main 生成并绑定唯一 owner webContents；项目实体读取复用 `ProjectSession.readText` 的权威 artifact ref/hash 校验。
- `app://bundle` protocol 做 method、URL 解码和 renderer-root containment 检查；窗口保持 sandbox/context isolation/web security、拒绝 popup/navigation/webview 和所有权限；CSP 不开放网络连接或 `unsafe-eval`。
- auth 文件只含 DPAPI/safeStorage 密文和非敏感元数据；无明文 fallback，corrupt 文件不自动删除，clear 要求确认。
- worker 入口被明确打包为 `ai-worker.js`；Electron fuse 包括 `GrantFileProtocolExtraPrivileges=disabled`，asar allowlist 排除测试、source map 和未批准文档。

## 验证结果

已执行：

```text
pnpm exec vitest run apps/desktop/main packages/shared/src/ipc.test.ts --reporter=dot
```

结果：6 个测试文件、26 项测试全部通过。

已执行完整 `pnpm verify`。结果：format、lint、全仓 typecheck、19 个 unit 文件共 208 项测试、1 项 component 测试及 main/preload/renderer 生产构建全部通过。

随后重新执行 `pnpm package:dir`，许可门禁覆盖 9 个生产依赖并成功生成 `release/win-unpacked`；Electron E2E 1/1 通过，package smoke 4/4 通过。实测确认自定义 `app://`、sandbox/preload 边界、Monaco worker、批准的 fuse（包括 `GrantFileProtocolExtraPrivileges=disabled`）、asar payload allowlist 和第三方许可清单。

这些结果证明现有断言稳定，但不覆盖上述阻断路径，因此不改变“不批准”的结论。

## 审查范围

完整阅读并核对 `AGENTS.md`、`GOAL.md`、`IMPLEMENTATION_PLAN.md`、`0009`，以及当前 shared/project/desktop/ai 实现、测试和打包配置。本次只新增本审查文档，未修改实现，未修改或写入 `<legacy-news-root>`，未调用真实 DeepSeek 服务。
