# 0009 Electron 主进程、安全 IPC 与凭据服务编码前独立审查

- 状态：有条件批准 Stage 5 编码
- 审查日期：2026-08-09
- 审查角色：独立 Electron/IPC/credentials review agent
- 依据：`AGENTS.md`、`GOAL.md`、`IMPLEMENTATION_PLAN.md`、`0001`、`0002`、`0003`、`0004`、`0007`、`0008`
- 范围：Electron main、preload、安全 IPC、项目会话、凭据服务、AI task host、日志安全和对应测试
- 不在范围：Stage 6 UI、DOCX、知识库内容审批或管理、旧项目导入、多供应商配置

## 结论

Stage 5 必要，但不需要新增顶层 package、数据库、凭据依赖、IPC 框架、日志框架或第二套任务/存储状态机。现有实现可以直接复用：

- `apps/desktop` 的 sandboxed BrowserWindow、本地 Monaco worker、CSP、导航拦截和打包安全测试；
- `packages/shared` 的品牌 ID、严格 Zod Schema 和 `SafeAppError`；
- `packages/domain` 的项目、版本、批注、配置和任务状态机；
- `packages/project` 的 canonical root、项目内逻辑路径约束、reparse-point 检查、单写者 `ProjectSession`、锁租约、原子 commit 和恢复；
- `packages/ai` 的固定 DeepSeek wire、一次一 worker、内容验收、worker shutdown 以及统一 `arbitrateTask(save/cancel/timeout)`；
- `packages/retrieval` 的只读 loader/search/report；本阶段不处理正式知识库资源尚未批准的问题。

没有不可执行的架构冲突。编码前必须接受本文冻结的最小 API、凭据恢复和窗口生命周期规则。尤其必须解决当前 `file:` + `GrantFileProtocolExtraPrivileges` 折中、worker 打包入口以及 shared 错误码缺口；不能先扩大 preload 再把这些问题留到后续阶段。

## 必要性、复用与依赖决定

### 采用

- Electron `43.3.0` 内置 `ipcMain`、`ipcRenderer`、`contextBridge`、`dialog`、`protocol`、`session` 和 `safeStorage`。
- 现有精确版本 `zod@4.4.3`，作为 main 和 preload 双向校验的唯一运行时 Schema 来源。
- Node 24/Electron 内置 `crypto.randomUUID`、`fs/promises`、`path` 和 worker threads。
- main 内部的窄 service/registry：project sessions、credentials、task hosts、IPC handlers 和 safe diagnostics。

### 不采用

- 不使用 `electron-store` 或 `conf`：它们不提供本项目凭据语义，项目存储已有正式事务协议。
- 不使用 `keytar`：它是原生扩展，会增加 Electron ABI 和 Windows 打包风险；`safeStorage` 已提供 DPAPI 边界。
- 不使用通用 typed-IPC/RPC 框架：固定的少量 channel 加共享 Zod Schema更易审计。
- 不使用 `pino`、`winston`、Sentry 或遥测 SDK：首版只需要字段白名单的本地安全诊断，不应引入任意对象序列化或外发能力。
- 不新增 worker pool、任务队列或 utility process；复用 Stage 4 的一任务一 worker 和项目单 active task 规则。

`apps/desktop/package.json` 必须显式声明实际使用的 workspace package 和 `zod`。main/preload 构建必须把纯 JS workspace 代码及其运行时依赖打进 asar，不能意外 externalize 后依赖开发机 `node_modules`。`electron` 和 Node built-ins 保持 external。锁文件和许可证门禁继续适用。

## 进程和模块边界

建议只在既有目录内拆分：

```text
apps/desktop/main/
  index.ts                app lifecycle only
  window.ts               protocol, BrowserWindow and navigation policy
  ipc.ts                  registration, sender checks and envelopes
  project-service.ts      opaque session registry and domain/project adapters
  credential-service.ts   userData auth envelope and safeStorage
  task-host.ts            ProjectSession <-> AiTaskCoordinator adapter
  diagnostics.ts          allowlisted safe events
apps/desktop/preload/
  index.ts                frozen named bridge only
packages/shared/
  ipc.ts                  channel constants and strict request/response/event Schema
```

这只是职责边界，不要求每个文件成为公开模块。main 是唯一受信任组合根；preload 只依赖 shared IPC contract；renderer 只得到 DTO，不得到领域聚合、磁盘 record/head、绝对路径、API Key、Node handle、AbortController 或任意 channel。

## 冻结的 renderer API

preload 只允许暴露下列命名方法。方法名是产品用例，不暴露 `send`、`invoke`、`on(channel)`、文件读写、shell 或 URL 请求能力。

```ts
interface NewsWriterApiV1 {
  runtime: {
    getInfo(): Promise<Result<RuntimeInfoDto>>;
  };
  auth: {
    getStatus(): Promise<Result<AuthStatusDto>>;
    setDeepSeekApiKey(input: { apiKey: string }): Promise<Result<AuthStatusDto>>;
    clearDeepSeekApiKey(input: { confirmed: true }): Promise<Result<AuthStatusDto>>;
  };
  projects: {
    createWithDialog(input: CreateProjectDto): Promise<Result<DialogResult<ProjectViewDto>>>;
    openWithDialog(): Promise<Result<DialogResult<ProjectViewDto>>>;
    close(input: SessionRequest): Promise<Result<{ closed: true }>>;
    refresh(input: SessionRequest): Promise<Result<ProjectViewDto>>;
    saveMinutes(input: SaveMinutesDto): Promise<Result<ProjectViewDto>>;
    importMinutesWithDialog(input: SessionRevisionDto): Promise<Result<DialogResult<ProjectViewDto>>>;
    updateConfig(input: UpdateProjectConfigDto): Promise<Result<ProjectViewDto>>;
    setArchived(input: SetArchivedDto): Promise<Result<ProjectViewDto>>;
    setLatestVersion(input: SetLatestVersionDto): Promise<Result<ProjectViewDto>>;
  };
  comments: {
    add(input: AddCommentDto): Promise<Result<ProjectViewDto>>;
    edit(input: EditCommentDto): Promise<Result<ProjectViewDto>>;
  };
  retrieval: {
    search(input: RetrievalQueryDto): Promise<Result<RetrievalViewDto>>;
  };
  tasks: {
    start(input: StartTaskDto): Promise<Result<TaskViewDto>>;
    cancel(input: CancelTaskDto): Promise<Result<CancelTaskResultDto>>;
    onStatus(listener: (event: TaskStatusEventDto) => void): () => void;
  };
}
```

约束如下：

1. `sessionId` 是 main 生成的不可猜 UUID capability，只映射到内存中的 `ProjectSession`，不是 `projectId`，不写项目，不在重启后复用。
2. 所有变更请求同时携带 `sessionId` 和 `expectedRevision`；main 以 session 的权威 revision/head 执行现有 optimistic concurrency，renderer 不能提交完整 aggregate 或磁盘引用。
3. `ProjectViewDto` 是显式 mapper 生成的只读视图，只包含 UI 需要的项目元数据、纪要文本、版本正文/关系、批注、Prompt/任务/检索摘要和当前 revision；不得直接复用磁盘 Schema。
4. 创建、打开和导入均由 main 打开原生 dialog。renderer 永远不能向这些方法传绝对路径。取消 dialog 是成功的 `DialogResult<{ cancelled: true }>`，不是错误。
5. `StartTaskDto` 只接收会话、revision、任务类型、最终实际发送的 `system/user` 文本、Prompt 编辑确认、单次非敏感配置和已存在检索报告 ID。main 生成 ID、时间、artifact ref、hash 和 upstream fingerprint，并从凭据服务取 key。
6. `tasks.start` 在 queued task 和 Prompt 已原子落盘后返回；后续状态由事件和 `projects.refresh` 观察。它不能等待完整 AI 请求才返回。
7. `tasks.cancel` 只调用该 session/task 的现有 coordinator；返回 `accepted | alreadyRequested | savingOrFinished`，文案层仍必须说明服务端可能继续处理或计费。
8. Stage 5 不暴露 DOCX API。Stage 7 审查通过后再增加 `documents.exportWithDialog`，不得现在放置通用 save-file channel。
9. 本阶段可以接通既有 retrieval 只读服务，但正式知识资源未批准时必须返回稳定的资源不可用错误；不得提供知识库管理入口或临时读取 `news`。

## IPC Schema 和 envelope

shared 应定义固定 channel 常量，例如 `nw:v1:projects:open`，禁止动态 channel。每个 channel 有独立的 strict request/data Schema。统一 envelope 为严格判别联合：

```ts
type IpcResult<T> =
  | { protocolVersion: 1; ok: true; data: T }
  | { protocolVersion: 1; ok: false; error: SafeAppError };
```

- main handler 首先校验 sender，再 parse request；业务返回在发送前 parse response。
- preload 在发送前再次 parse request，在 resolve 后 parse完整 envelope；事件进入 listener 前也 parse。
- renderer 可以导入推导出的 DTO 类型，但不能绕过 preload 取得 `ipcRenderer`。
- 所有对象 `.strict()`；文本、数组和 byte size 有明确上限；拒绝 prototype-bearing/未知字段输入。
- IPC validation error 只映射为 `IPC_PROTOCOL_INVALID`，不回传 Zod issues、原始 payload、stack 或绝对路径。
- handler 只返回普通可结构化克隆数据。错误必须捕获并映射到 `SafeAppError`；不能让 Electron 把原始异常 message/stack 作为 rejected invoke 传播。
- task event 只有一个固定 channel，包含 `sessionId`、`taskId`、当前状态、发生时间和可选安全错误；不含 Prompt、正文、key 或 worker wire event。

需要在 shared 增加以下安全错误码并同步 Schema/测试：

- `IPC_PROTOCOL_INVALID`：请求、响应或 event 不符合协议；
- `IPC_SENDER_REJECTED`：非受信页面、子 frame、已销毁 sender 或不属于该 sender 的 session；
- `AUTH_STORAGE_UNAVAILABLE`：Windows `safeStorage` 不可用，禁止明文 fallback；
- `AUTH_STORAGE_CORRUPT`：auth envelope 非法或密文无法解密；
- `RESOURCE_UNAVAILABLE`：只读运行时资源缺失/损坏且没有更具体的既有错误。

凭据保存的 I/O 错误可以安全映射为 `AUTH_STORAGE_UNAVAILABLE` 并附 allowlisted causeCode；不新增包含路径的错误。领域错误必须由显式表映射到既有 `PROJECT_*`/安全错误，不允许 `UNKNOWN` 成为常规分支。

## sender 身份、会话归属和路径安全

每次 invoke 和 event subscription 都必须满足：

1. `event.sender` 是当前唯一主窗口的 `webContents`，未销毁；
2. `event.senderFrame` 是该 webContents 的 top-level main frame，不接受 iframe；
3. URL 精确匹配受控 `app://bundle/...`；开发态仅接受由现有 localhost 校验器产生的唯一 dev origin；
4. session registry 中 `sessionId` 的 owner 等于该 `webContents.id`，且 session 未 closing/closed；
5. task/comment/version ID 必须在该 session 的权威 aggregate 中存在并符合业务关系，不能只因 UUID 格式正确就接受。

打开任意可写目录的含义是“用户通过原生 dialog 明确选择，main 再 canonicalize 并验证”，不是 renderer 可传任意路径。打开后只使用 `ProjectSession.root` 和项目内品牌相对路径。继续复用 project 包的 `realpath`、`path.resolve/relative`、reparse-point 拒绝、固定布局和 hash 校验；main 不手工拼路径，也不提供任意 read/write。

同一 canonical root 在进程内复用现有 active session；不同进程依赖 `.news-writer/write.lock`。main registry 对一个 root 只建立一个 owner session capability，重复打开返回已有视图而不产生第二套写队列。stale lock recovery 必须是独立的、显示 observed instance ID 并要求 `confirmed:true` 的后续 API；不得在普通 open 中自动破锁。若 Stage 6 尚未设计确认 UI，Stage 5 可以先安全返回 `PROJECT_LOCK_RECOVERY_REQUIRED`，不能静默恢复。

## 凭据格式与恢复

唯一凭据文件为：

```text
app.getPath('userData')/auth.json
```

V1 严格格式：

```ts
{
  format: 'news-writer-auth';
  version: 1;
  provider: 'deepseek';
  encryptedApiKey: string; // safeStorage ciphertext 的 base64
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

规则：

- Windows 上保存前必须 `safeStorage.isEncryptionAvailable() === true`；使用 `encryptString`/`decryptString`。绝不使用 plaintext fallback，绝不把 key 放入 user config、环境变量、项目或日志。
- 写入采用 userData 内同目录临时文件、flush 和原子替换；文件只包含密文和非敏感元数据。继续依赖 Windows 用户目录 ACL，不引入 keytar。
- `getStatus` 只返回 `notConfigured | configured | unavailable | corrupt`、provider 和非敏感更新时间；绝不返回密文、key 长度、前后缀或可验证 hash。
- `setDeepSeekApiKey` 对 trim 后空值和 4096 上限做校验；不 trim 合法 key 的实际内容。成功加密并原子保存后才返回 configured。preload/main 不记录 input，renderer 应在调用 settle 后清空表单状态。
- 读取时先限制文件大小，再 strict parse、base64 decode、decrypt。任何失败都不自动删除或降级明文，返回 `AUTH_STORAGE_CORRUPT`；原文件保留供诊断。
- 恢复只有两条显式路径：用户提交新 key 原子覆盖，或 `clearDeepSeekApiKey({confirmed:true})` 删除 auth 文件。clear 不因文件损坏而拒绝，但不得递归删除 userData。
- decrypt 后 key 只在 main 内短期存在，并仅作为一次性 worker start 消息传入 Stage 4；不缓存到长期 service、global、crash report 或 recent-project state。JS string 无法可靠清零，因此以最短生命周期和不复制/不记录为边界。
- 项目复制、portable app 目录复制和应用升级均不复制 auth。DPAPI 密文换 Windows 用户/机器后解密失败是 `corrupt/unavailable` 恢复流程，不应误报 `AUTH_REJECTED`。

## task host 与窗口生命周期

每个打开 session 最多一个 `AiTaskCoordinator` 和一个 active task handle。`TaskExecutionPort.transition/fail/arbitrateTask` 必须通过同一个 session host 串行器和 `ProjectSession.commit`；不得在 main 内以另一把内存锁重演 winner。`save/cancel/timeout` 继续以 Stage 4 已批准的持久化 winner 为准。

成功路径固定为：原子 queue Prompt/task -> 取凭据并执行 coordinator -> `arbitrateTask(save)` 提交 saving -> host 使用既有 `completeTaskWithVersion` 事务完成版本。失败、取消、超时、worker exit、renderer 消失和关闭窗口均不得直接创建 Version。

生命周期冻结如下：

- renderer 普通 reload：main 拥有的 task 不取消，ProjectSession 和 worker 继续；旧 document 的 listener 自动失效，新可信 document 通过 `projects.refresh` 恢复状态并重新订阅。不得把 renderer Promise 生命周期当任务生命周期。
- renderer crash：按 reload 相同原则保留 task；记录安全诊断，恢复页面后刷新。若 webContents 被销毁则进入下条。
- 关闭项目：若无 active task，关闭 session 并释放 lock；有 active task 时返回 `PROJECT_STATE_CONFLICT`，由 UI 先显式取消并等待 terminal，再重试关闭。不能“关闭项目但后台仍写该目录”。
- 关闭窗口或退出 App：阻止立即销毁，向所有可取消 task 提交 cancel，等待持久化 terminal 和 worker shutdown，再关闭 session/lock；已进入 saving 的任务必须等待现有成功事务/恢复边界完成。设置有限的内部 shutdown watchdog 只能转安全诊断并让下次恢复，不能伪造 cancelled 或 succeeded。
- `render-process-gone` 后若窗口不会恢复，执行与退出相同的受控 shutdown；若 Electron 正在重载并保留 webContents，则按 reload 处理。
- task event 只发送给 owner webContents；destroyed/navigation 时移除 listener。发送失败不影响 task 的权威持久化状态。

## 窗口、协议、导航和 CSP

Stage 5 扩大 preload 能力，按 `0002` 必须结束当前 `file:` 特权折中：

1. 在 app ready 前注册受控、standard、secure 的 `app` scheme，只服务打包 renderer 根内的已构建文件；URL 解码、normalize 后必须再次验证 containment，拒绝 traversal、NUL、反斜杠和非 allowlisted method。
2. 生产页面固定为 `app://bundle/index.html`。打包 smoke 通过后将 `GrantFileProtocolExtraPrivileges` fuse 改为 disabled；若 Monaco/asar 因此不能工作，应暂停扩大 IPC 并由主 agent记录新的安全例外，不能静默保持旧 fuse。
3. 保持 `contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`、`webSecurity:true`，并显式 `webviewTag:false`；生产 `devTools:false`。
4. 保持 `window.open` 拒绝，增加 `will-redirect` 和 `will-attach-webview` 拒绝；`will-navigate` 只允许当前受信文档本身，不允许 HTTP(S)、data、javascript 或外部文件。
5. 对主 session 设置 permission request/check handler 全拒绝；首版不需要摄像头、麦克风、地理位置、通知、剪贴板读取或 MIDI。
6. CSP 保持 `default-src 'self'`、`object-src 'none'`、`base-uri 'none'`、`connect-src 'self'` 和无 `unsafe-eval`。Monaco 所需 `worker-src 'self' blob:`、现有 style inline 例外须由 packaged E2E 证明，不能为 IPC 放宽 `connect-src`。

preload 的 ESLint 规则应从“禁止导入 ipcRenderer”调整为“只允许 preload 固定实现导入，禁止任何导出/动态 channel”。这不是删除边界门禁。

## 安全日志

诊断 API 只接受预定义 event name 和字段白名单：app/runtime version、diagnostic ID、projectId/taskId/sessionId、状态、安全错误码、有限 HTTP 分类和耗时桶。禁止接收任意 object、Error、headers 或 renderer 提供的 message。

日志不得包含 API Key/密文、Prompt、纪要、新闻稿、批注、检索 query/excerpt、Authorization、响应 body、绝对路径、用户名或 stack。项目路径只记录随机 sessionId；文件系统错误只记录 allowlisted causeCode。所有未知异常先生成随机 diagnostic ID，再向用户返回固定安全文案。测试和开发日志也使用虚构 key，并接受全量 secret/path scanner。

首版可以只写 userData 下有界本地诊断文件或保持内存/console allowlist；无论选择哪种，不得为“脱敏”而先序列化原始对象再正则替换。若写文件，使用异步串行 append、大小上限和固定轮换文件名，不写项目目录。

## 测试和 E2E 门禁

### Schema 与 handler 单元测试

- 每个 request/result/event 正反 parse；未知字段、过长文本、伪造 ID、非法 revision 和 prototype payload 均拒绝。
- main 与 preload 两侧都验证；handler 抛出的原始 Error 不穿越 IPC。
- 非 owner webContents、iframe、错误 URL、destroyed sender、其他 session/task/version ID 全部拒绝。
- renderer 无通用 invoke/on/send、Node、fs、credential、path 或 worker 能力；bridge key 精确快照。

### 路径和 session 集成测试

- dialog 取消、任意可写中文长路径、新项目、已有项目、只读目录、磁盘错误和冲突 revision。
- traversal、绝对路径注入、UNC/盘符逻辑路径、symlink/junction/reparse、root 替换和 TOCTOU 后安全失败。
- 同 root 重复打开复用一个 session；第二进程锁定；stale lock 未确认不恢复；关闭释放 lock。
- 所有 mutation 经现有 `ProjectSession.commit`，故障注入后 reopen/recovery 结果与 Stage 2 一致。

### 凭据测试

- Electron Windows 环境中真实 `safeStorage` encrypt/decrypt round trip；磁盘只出现密文且 scanner 找不到假 key。
- unavailable、空 key、过长 key、截断 JSON、未知字段、非法 base64、decrypt failure、原子替换失败、覆盖恢复和确认 clear。
- IPC `getStatus`/错误/日志/项目/打包产物均不含明文 key、密文、前后缀或 hash。

### task host barrier 测试

- start 原子落 queued 后才返回；缺凭据不 spawn worker；Prompt 含实际 key 时硬阻断。
- response/cancel/timeout 继续复用 Stage 4 barrier，另断言 API 返回、event、磁盘 task 和版本完全一致。
- reload 中 task 继续且新页面 refresh 恢复；关闭项目在 active task 时拒绝；退出取消后等待 worker；saving 时等待事务。
- 401/402/429/500/503、网络、协议、空/无效正文、worker crash 后版本数量、latest 和旧正文 hash 不变。

### Electron 与打包 E2E

- 源态和 `win-unpacked` 均验证自定义 `app://`、CSP、Monaco worker、sandbox preferences、全拒绝权限和导航/弹窗/webview 注入。
- 伪造 channel、iframe invoke、跨 session capability、renderer path 注入、event 伪造和 XSS probe 不能取得文件或凭据。
- fuse 实测 `GrantFileProtocolExtraPrivileges=disabled`，其余 `0002` fuse 保持；若未达到则 Stage 5 不退出。
- worker entry 和全部 workspace 运行时代码存在于 asar，删除源码与开发 `node_modules` 后任务 worker 仍可启动；产物没有 `.map`、测试、凭据、开发路径或未批准资源。
- `pnpm verify`、Electron E2E、`package:dir`、package smoke、许可证和最终 `format:check` 全部通过。

## Coding agent 准入范围

主 agent 接受本文边界后，批准 coding agent：

- 在 shared 增加上述 IPC DTO/channel/event Schema 和五个安全错误码；
- 在 desktop main/preload 实现受控 protocol/window、session registry、credential service、task host、固定 handlers 和安全诊断；
- 为 desktop 增加已存在 workspace package/`zod` 的显式依赖，并修正 main/preload/worker 的打包入口；
- 增加本文单元、集成、Electron 和 package 测试。

禁止：实现 Stage 6 工作台 UI、DOCX、知识库管理、旧项目导入、任意文件 API、公开 provider/base URL/header、流式、自动重试、明文 key fallback、遥测或修改 `<legacy-news-root>`。

## 阻断项与批准条件

没有产品决策冲突。以下是 Stage 5 退出前阻断项，也是 coding agent 必须一并完成的范围：

1. shared 尚无 IPC DTO/envelope 及 `IPC_*`、credential storage、resource unavailable 错误码。
2. 当前 preload 没有 IPC，desktop 也未显式声明/bundle workspace 运行时依赖。
3. 当前生产仍使用 `file:` 且 `GrantFileProtocolExtraPrivileges` 开启；扩大 preload 前必须迁移受控 scheme 并用 packaged smoke 关闭 fuse。
4. Stage 4 worker entry 尚未作为 desktop 打包入口验证，不能假设源码相对路径在 asar 中存在。
5. auth.json 原子存储、safeStorage unavailable/corrupt/clear recovery 尚未实现。
6. reload、项目关闭、窗口退出与 active/saving task 的上述语义尚未形成 host 测试。

这些均是本阶段实现事项，不要求修改总体架构，也不阻止 coding agent 在主 agent 明确批准后开工。全部关闭并通过独立 post-review 后，Stage 5 才可作为 Stage 6 依赖。
