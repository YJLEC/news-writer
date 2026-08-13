# 0016 owner session 恢复与 E2E mock AI 编码前独立审查

- 状态：有条件批准编码
- 审查日期：2026-08-10
- 审查角色：独立 Electron session/task/E2E review agent
- 依据：`AGENTS.md`、`GOAL.md`、`IMPLEMENTATION_PLAN.md`、`0009-electron-ipc-credentials-review.md`、`0010-electron-ipc-credentials-post-review.md`、`0011-monaco-workspace-review.md`、`0013-prompt-preparation-post-review.md`、`0014-lock-recovery-post-review.md`、`0015-monaco-workspace-post-review.md`
- 检查范围：当前 `ProjectService`、fixed IPC、preload bridge、`TaskHostService`、`WorkerRunner`、Electron 组合根、electron-vite/electron-builder、Electron E2E 和 package smoke
- 允许编码范围：A) 当前可信 sender 的唯一 owner session hydrate/resume；B) 仅 Electron E2E 构建可用的可控 mock AI runner 和对应测试接线
- 不在范围：renderer 其余 P1/P2 修复、DOCX、知识库、生产 AI 协议变更、多供应商、测试后门、原项目 `<legacy-news-root>`

## 结论

两个能力都是关闭 `0015` 阻断项所必需的，但都不需要新顶层 package、数据库、RPC 框架、HTTP mock server、网络拦截库或生产 transport 抽象。

1. reload 后 main 中的 `ProjectSession`、opaque `sessionId`、TaskHost active handle 和项目锁仍然存在；丢失的只是新 document 对 owner session 的引用。因此应增加一个固定、空请求、owner-scoped 的 hydrate/resume IPC，而不是把 `sessionId`、项目路径或最近项目写入 renderer 存储。
2. `packages/ai` 已有成熟且足够窄的 `WorkerRunner`/`WorkerRun` 注入边界，`TaskHostService` 构造器也已经接收该 port。E2E mock 应实现这个既有 port，并在独立测试构建的 main 组合根注入；不能修改 DeepSeek wire，不能从 renderer 控制 mock，也不能增加生产 IPC。

没有不可执行的架构冲突。编码批准以本文的契约、唯一 owner 规则、任务收敛规则和生产排除证明全部落实为前提。任一实现若要求 renderer 提交 `sessionId`/路径来恢复、允许运行时环境变量在生产 main 中切换 transport，或把 mock channel 暴露到 preload，均不在批准范围。

## 必要性、复用与开源方案评估

### A. owner session hydrate/resume

必要性成立。当前 `projects.refresh` 要求 renderer 已持有 `sessionId + expectedRevision`；reload 后两者均不可靠，而把 capability 写入 `localStorage`、URL、日志或项目文件违反 `0009/0011`。此外 task event 只是提示，现有带 CAS 的 refresh 无法在 revision 已前进时取得新快照；owner hydrate 可以作为 boot、event 和冲突后的权威读取入口。

直接复用：

- `isTrustedSender` 对唯一主窗口、top frame 和受信 origin 的校验；
- fixed channel、main/preload 双端 strict Zod 和统一 `IpcResult`；
- `ProjectService.#sessions` 的 main-only opaque capability/owner registry；
- 全局 `credentialProjectGate`，与 task transition、save/cancel/complete 和项目 mutation 线性化；
- 现有 `ProjectViewDto` mapper。不得新建第二份 hydrate DTO 或直接返回 aggregate。

不引入 Electron Store、Redux persistence、sessionStorage helper、RPC 框架或 recent-project 数据库。它们不能证明 owner 身份，并会扩大 capability 持久化面。

### B. Electron E2E mock AI

必要性成立。现有 E2E 只证明 sandbox/bridge/auth 和有限工作区视觉流程，没有真实经过 main/preload/project/TaskHost 的成功版本、失败不造版、取消、超时、分支和 reload 流程。真实 DeepSeek 不适合作为确定性 CI 门禁，也不能稳定制造 saving、空响应和竞争时序。

直接复用：

- `WorkerRunner.run(taskId, input, apiKey, onStatus)` 和 `WorkerRun` 的 result/cancel/shutdown/terminate 合约；
- `AiTaskCoordinator` 的 timeout、cancel、内容验收和仲裁；
- `TaskHostService` 的 queue、Prompt 持久化、配置快照、成功事务和失败收口；
- 现有 Playwright Electron launcher、Vitest 和 package smoke。

不采用 MSW、Nock、undici MockAgent、Prism、WireMock 或本地 HTTP mock server。mock 位于 `WorkerRunner` 边界比拦截网络更窄：无需监听端口、伪造 TLS/DeepSeek wire 或改变 CSP，也不会把测试服务引入产品。无需新生产依赖或许可证；严格计划校验继续使用已锁定的 `zod@4.4.3`。

## A. 冻结的 owner session hydrate/resume 契约

### 固定 IPC 和 DTO

只增加一个 fixed invoke channel，例如：

```ts
IPC_CHANNELS.projectsResumeOwned = 'nw:v1:projects:resume-owned';

const resumeOwnedProjectResultSchema = z.discriminatedUnion('state', [
  ipcObject({ state: z.literal('none') }),
  ipcObject({ state: z.literal('resumed'), project: projectViewDtoSchema }),
]);

interface NewsWriterApiV1 {
  projects: {
    resumeOwned(): Promise<IpcResult<ResumeOwnedProjectResult>>;
  };
}
```

请求必须使用现有 strict `emptyRequestSchema`。renderer 不得传 `sessionId`、`projectId`、`expectedRevision`、路径、owner id、window id、task id 或任何候选条件。preload 只增加命名方法 `projects.resumeOwned()`；不增加通用 `invoke/send/on`。

返回只允许两态：

- owner 当前没有可用 session：`{state:'none'}`，这是正常成功结果；
- owner 恰有一个未 closing session：`{state:'resumed', project: ProjectViewDto}`。

不得返回 session 列表、数量、根路径、其他 owner 的任何标识，不能让 renderer 选择 session。异常发现同一 owner 有多个未关闭 session时，返回安全的 `PROJECT_STATE_CONFLICT`（可带随机 diagnostic id），记录 allowlisted 内部诊断，但不透露数量、sessionId 或路径；不得任取第一个、最近打开或 revision 最大者。

### owner、revision 和存储行为

1. owner 身份只来自通过 `isTrustedSender` 的 `event.sender.id`。main handler 不接受 renderer 声称的 owner。
2. 查询只在 `ProjectService` 内部 registry 中按 `ownerId` 和 `closing === false` 过滤。不得按 `projectId`、路径、磁盘扫描或 recent list 恢复。
3. 恢复返回原 main session 的同一个 opaque `sessionId`，不旋转、不复制、不重新打开目录，也不新取锁。它只把本来已属于该 sender 的 capability 交还给同一 sender 的新 document。
4. 操作必须进入现有 shared linearization gate，并在其中调用现有 `ProjectSession.refresh()` 后生成 view，使 post-HEAD 原子提交、TaskHost transition 和 hydrate 有确定顺序。不得要求 renderer 提交 `expectedRevision`；返回 refresh 后的权威 revision。
5. refresh 后继续执行既有项目/credential secret 安全检查。失败按现有安全错误映射返回，不能输出原始异常、绝对路径或项目内容。
6. 该操作不调用 `#finishOpen`、不注册新 session、不执行 stale-lock recovery，也绝不能调用 `#recoverInterruptedTask`。页面 reload 不等于 App 停止；仍在运行的 worker/task 必须继续。
7. 不修改项目 aggregate、head、任务或锁，因此没有 project revision 增量。`ProjectSession.refresh()` 仅用于读取/恢复已经原子提交的权威 head。
8. `close/closeAll` 与 resume 同 gate 串行：close 先赢则返回 `none`，resume 先赢可返回当时快照，后续 close 仍使旧 capability 失效。closing session 不返回。

当前 main API 理论上允许同一 owner 打开多个不同 root。实现本能力时至少必须把“异常多个安全失败”写入测试；不能借 resume 静默改变或关闭用户项目。是否进一步在 create/open/register 前强制“一窗口一项目”应由主 agent按现有 UI 切换语义单独决定，不是本小模块扩权理由。

### reload 与 task 收敛

renderer bootstrap 顺序冻结为：先注册 `tasks.onStatus`，再读取 runtime/auth/user config 与 `projects.resumeOwned()`，最后进入 welcome 或安装返回的权威 workspace view。不得在浏览器持久存储中保存 session、Prompt、纪要或项目路径。

task event 继续只作为“权威状态可能变化”的提示。renderer 应实现不可丢弃的 coalesced hydrate：

- start/cancel settle 后安排一次 `resumeOwned()`；
- 匹配当前 session 的 task event 后安排一次；
- hydrate 进行中又收到 event 时记一个 dirty bit，当前请求 settle 后至少再执行一次；
- boot 期间到达的 event 先标记 dirty，不把 event 中的 `sessionId` 当作恢复输入；
- mutation/CAS conflict 后可用同一 owner hydrate 获取最新 view，并保留本地未保存草稿；不自动重放 mutation。

权威 view 只能按返回的 revision 替换；过时 hydrate 响应不得覆盖更新的 view。快速成功、快速失败、立即取消、saving 与 terminal event 竞争时，循环必须最终停在磁盘终态。活动任务 reload 后仍由原 `TaskHostService.#active` 和 worker 驱动；resume 只恢复 UI，不重启请求。App 真正退出后再次打开项目，仍沿用 `#finishOpen` 将遗留非终态任务标为 `TASK_INTERRUPTED`，两种语义不得混淆。

## B. 冻结的 E2E mock AI 边界

### 组合根和 build-time 启用

产品 `TaskHostService` 和 `packages/ai` 公共协议无需改变。允许把当前 main lifecycle/composition 抽成内部 bootstrap factory，以 `WorkerRunner`（或返回它的 factory）为唯一 AI 注入点：

- production main entry 只构造 `new NodeWorkerRunner(new URL('./ai-worker.js', import.meta.url))`；
- E2E main entry 只构造 `ControlledMockWorkerRunner`；
- 两个 entry 共用真实 BrowserWindow、preload、fixed IPC、CredentialService、ProjectService、TaskHostService、safeStorage、项目文件和 renderer。

必须使用独立 electron-vite E2E build mode/entry。mock 源码不能被 production main entry 静态或动态导入；生产 bundle 中不能保留“运行时判断后未使用”的 mock 分支。`process.env`、命令行参数、文件存在、用户目录内容和 renderer 消息都不能使 production main 从 `NodeWorkerRunner` 切到 mock。

建议测试脚本顺序为：正常 TypeScript/workspace build -> `electron-vite build --mode e2e` 生成仅供 Playwright 使用的测试 main -> 运行 Electron E2E。`package:dir` 必须无条件重新执行普通 production build 后再 electron-builder，不能复用 E2E 输出。若 E2E 与 production 共用输出路径，脚本必须串行且 package 命令先清理/重建该输出；更稳妥的是把 E2E main 输出到明确不匹配 `electron-builder.yml files` 的隔离目录。

E2E entry 启动时还必须同时满足：编译期 E2E entry、`app.isPackaged === false`、测试 runner 提供的精确 enable sentinel 和一份通过 strict Schema 的有界计划。任一条件缺失立即安全失败，不得回退真实 DeepSeek。该 sentinel/计划只由 Playwright 启动 Electron 的主进程环境或 argv 提供；renderer 和 preload没有读取、设置或查询接口。

### 可控计划和 runner 行为

计划是启动前固定的、只含合成数据的 strict 判别联合队列；不得接收函数、模块路径、URL、header、credential、项目路径或任意错误对象。每个 step 至少可表达：

- `success`：有界 article content、合成 completion id/usage，以及 requesting/processing/completion 的确定性延迟；
- `safeFailure`：allowlist 中的 AI safe error code 和固定延迟；
- `empty`/`invalidContent`：由真实领域内容验收拒绝；
- `hang`：由真实 `AiTaskCoordinator` timeout 收口；
- `delayedSuccess`：供 cancel 与 response/saving 竞争测试。

计划应限制 step 数、每段文本长度和总字节数；每次 `run` 原子消费一个 step，耗尽或 task 次序不匹配时以固定 `PROTOCOL_INVALID/TASK_INTERRUPTED` 测试失败收口，不能访问网络。mock 必须实现现有 `WorkerRun` 的幂等 cancel/shutdown/terminate，清理所有 timer，并确保 Promise 只 settle 一次。它可以调用 `onStatus('requesting'|'processing')`，但不能绕过 `AiTaskCoordinator` 直接写 task/version。

mock runner 仍接收 TaskHost 传来的 API key，这是现有 port 合约；只能验证“非空且有界”，不得保存、hash、回显、写计划、日志或断言快照。E2E 继续经过真实 `CredentialService/safeStorage` 配置虚构 key。实际发送的 Prompt、模型、推理强度、parent、批注和 supplemental facts 应从测试结束后的项目 records/artifacts及 UI view 验证，而不是让 mock 建立第二份含正文/Prompt 的审计日志。

不得新增 `mock:*`、`tests:*` IPC channel，不得改变 `NewsWriterApiV1` bridge（除 A 中批准的 `projects.resumeOwned`），不得给 renderer 暴露“下一响应”“推进到 saving”“查看请求”之类控制。需要特殊时序时，用启动计划和确定性延迟表达；一个场景无法可靠表达时拆成独立 Electron process/test case。

### 生产包排除证明

以下全部是 release 门禁：

1. `package:dir` 先运行普通 production build；E2E build 产物不在 `electron-builder.yml` 的 `files` 匹配范围，或在构建前被明确替换。
2. production `app.asar` allowlist 仍只允许批准的 main/preload/renderer/worker 文件，不允许 e2e entry、mock runner、plan、fixture 或 tests 目录。
3. package smoke 解包所有文本 bundle，断言不存在稳定 mock marker、enable sentinel 名、测试计划 Schema 标识、合成 completion marker和测试 entry 名。仅检查文件名不足，因为 bundler 可内联 mock。
4. packaged app 即使由外部设置同名环境变量/argv，也继续构造真实 `NodeWorkerRunner`；package smoke 增加该负向启动验证。
5. renderer bridge key 快照只因 A 增加 `projects.resumeOwned`，不存在 mock 控制面；生产 CSP、导航、权限和 Node 探针继续通过。
6. mock 不得成为 production dependency，许可证清单不新增依赖。

## 编码和测试验收

### owner resume 单元/集成

- shared：empty request、`none/resumed` strict result、未知字段/伪造字段拒绝，main/preload 双向 parse。
- IPC：非主窗口、child frame、错误 origin、destroyed sender拒绝；renderer 传 session/path/owner/revision 均因 strict empty request 拒绝。
- ProjectService：0 session 返回 none；1 个当前 owner session refresh 后返回原 sessionId 和最新 revision；其他 owner session不可见；closing 不返回；异常多个返回脱敏 state conflict。
- 竞争：resume 与 task transition、success completion、cancel、close、closeAll、credential replacement 同 gate 串行；post-HEAD 响应丢失后 hydrate 返回磁盘权威 head。
- 安全：返回/错误/诊断不含路径、项目内容、其他 session、API key 或 raw exception。

### reload/task Electron E2E

- 打开项目后 reload 回到同一 workspace，不进入 welcome，不写 local/session storage；sessionId 仅来自 resume response。
- requesting/processing 中 reload，任务不中断、不重启、不重复消费 mock step，history 保留并最终成功。
- 快速成功、快速失败、立即取消、saving/terminal event 在 IPC settle 前后到达，最终 UI revision、task status、version count 和 latest 与项目磁盘一致。
- event 重复/丢失/乱序提示不成为真源；hydrate in-flight dirty 再跑一次，不会被普通 pending mutation丢弃。
- 真正关闭 App 后重开项目仍把遗留非终态按既有规则收为 `TASK_INTERRUPTED`，不误当 reload 恢复。

### mock-AI 完整工作流 Electron E2E

至少按 `0011/0015` 拆成可诊断场景：

1. official：完整纪要、缺项显示与修正、Prompt 预览/首次编辑警告、初稿、补充事实二次审稿。
2. latest 选区批注并续改：磁盘实际 Prompt 含父版批注快照；新版本不继承批注；DOCX 尚不在本阶段。
3. 回溯历史为 latest、编辑当时批注、续改形成新分支；再切回原 latest，current chain、parent/latest 和 diff 恢复正确。
4. other profile、零命中与知识资源 unavailable 区分，且无知识库管理入口。
5. cancel、timeout、safe failure、empty/invalid response：均不增加成功版本，不移动 latest，不覆盖旧正文；取消文案不承诺停止计费。
6. active reload、CAS conflict 保留草稿、active close 拒绝、归档/恢复、认证未配置/损坏。
7. stale-lock 确认/取消与既有安全 E2E；伪造 IPC、Node/path/credential 探针继续失败。

断言不能只看按钮或 toast。测试结束后由 Playwright/Node 读取测试自己创建的项目目录，使用正式 project Schema/reader核对 task history、实际 Prompt artifact、config snapshot、parentVersionId、latestVersionId、版本数、批注归属、supplement/retrieval trace 和失败不造版。所有内容和 key 必须是虚构 fixture；日志与产物继续经过 secret/path scanner。

### 全量门禁

实现后必须通过 format、lint、typecheck、unit/component、普通 production build、完整 Electron E2E、`package:dir`、package smoke、许可证和 asar allowlist。另由独立 post-review agent确认：resume 没有枚举/跨 owner/capability 持久化，mock 不在 production bundle 或协议面，完整工作流确实经过真实 main/preload/project/TaskHost。

## Coding agent 准入与禁止项

批准 coding agent 在既有 `packages/shared`、`apps/desktop/main`、`apps/desktop/preload`、renderer bootstrap/E2E build/tests 范围内实现上述窄能力。主 agent负责决定文件拆分、集成顺序和验收；完成后必须独立复审，未复审前不能据此关闭 `0015` 或进入 Stage 7。

禁止：

- renderer 提交或持久化 sessionId/path 后调用 resume；
- 返回 owner session 列表或从多个 session 中静默选一个；
- reload 时重开项目、重取锁、恢复 interrupted task 或重启 AI 请求；
- 修改生产 DeepSeek wire、AI 内容验收或仲裁规则来迁就测试；
- 用 production 环境变量、argv、文件或隐藏 IPC 切换 mock；
- 将 mock/计划/fixture/测试 key 打入便携包；
- 让 mock 直接创建版本、写项目或记录 Prompt/key；
- 修改 `<legacy-news-root>`。

## 最终批准

A 和 B 均有明确必要性，且可完全复用当前 owner registry、strict fixed IPC、shared gate、`WorkerRunner` 和 Playwright 基线。按本文边界实现时，不会改变 renderer 无 Node/路径/凭据能力，也不会扩大生产 AI 或 IPC 攻击面。批准进入小范围编码；只有完成上述测试和生产排除证明并通过独立复审后，才能认为 `0015` 的 reload/task 对账与 mock-AI E2E 阻断已关闭。
