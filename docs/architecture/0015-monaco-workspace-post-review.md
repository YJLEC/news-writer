# 0015 Stage 6 Monaco 工作台独立复审

日期：2026-08-10

状态：**不批准进入 Stage 7。** Renderer 的安全边界、基础 Monaco 生命周期、版本投影、Prompt 首次编辑警告和三档视口基础布局成立，但 Stage 6 仍有任务恢复与权威对账、完整 mock-AI E2E、实时配置来源、缺项交互和批注锚点等阻断项。本文只记录审查结果，未修改产品实现或 `<legacy-news-root>`。

## 审查依据和范围

完整对照 `AGENTS.md`、`GOAL.md`、`IMPLEMENTATION_PLAN.md`、`docs/architecture/0011-monaco-workspace-review.md`、已批准的 `0013-prompt-preparation-post-review.md` 和 `0014-lock-recovery-post-review.md`。审查范围包括 `apps/desktop/renderer`、相关 shared/main/preload 投影、unit/component/Electron E2E、三档截图、便携打包、package smoke 和许可证。

任务描述中的“0013/0014”实际对应仓库现存的上述两个文件；仓库没有 `0014-monaco-workspace-implementation.md`，本审查未假定该文件存在。

## 阻断发现

### P1：task event 不能保证权威 view 对账，reload 后无法恢复已打开项目和活动任务

`apps/desktop/renderer/src/App.tsx:746-778` 的 `enqueue` 在任一命令 pending 时直接丢弃新命令，并非真正排队。`tasks.start` 在 `:916-945` 丢弃返回的 `TaskViewDto`，随后调用的 `refresh()` 会因当前 start 命令仍 pending 而被丢弃；task event 在 `:800-806` 触发的 refresh 同样可能被丢弃。`workspaceReducer` 在 `workspaceState.ts:154-162` 只保存 `lastTaskEvent`，不更新 UI 正在读取的 `view.tasks`。尤其 `tasks.cancel` 在 `App.tsx:1094-1106` 没有成功后的强制 refresh，若 terminal event 在 cancel IPC settle 前到达，界面会继续显示旧 active 状态且没有后续事件纠正。

页面 reload 后 `App.tsx:1744-1760` 只查询 runtime/auth/user config 并进入 welcome。main 仍以同一个 `webContents.id` 持有 owner-bound session，但 renderer 已丢失不透明 `sessionId`；现有 IPC 没有恢复当前 owner session 的方法。因此该要求不能只靠 React 修复，也不应把 session token 写入浏览器存储。

精确修复要求：

- 把 task event 视为提示，建立不会被普通 mutation 丢弃的串行/合并权威 refresh；start、cancel 和 terminal event settle 后必须最终取得磁盘权威 `ProjectViewDto`。
- 新增能力前先按 `AGENTS.md` 独立审查一个无路径、无 renderer 提交 session id、仅返回当前 sender 已拥有 session 的窄 resume/hydrate IPC；boot 时调用它恢复 workspace、活动任务状态和持久化 history。
- 增加快速成功、快速失败、立即取消、saving、terminal event 与 mutation 竞争、页面 reload 的测试，证明最终 revision、latest、版本数和任务状态收敛。

### P1：Stage 6 明定的完整 mock-AI Electron E2E 不存在

`tests/e2e/app.spec.ts` 只有 renderer 沙箱/bridge/认证边界；`tests/e2e/workspace-visual.spec.ts` 只执行配置 synthetic key、新建、保存纪要、准备 Prompt 和首次编辑警告。没有可控 mock transport，也没有生成成功版本。

因此 `IMPLEMENTATION_PLAN.md` Stage 6 的“模拟 AI 完成全部日常流程及版本分支操作”退出条件，以及 `0011` 第 176-183 行矩阵均未满足。当前没有 Electron E2E 证明：初稿、缺项、二次审稿、批注快照续改、新版不继承批注、历史回溯、分支、diff、取消/超时/空响应不造版、冲突保草稿、active reload、归档/恢复和 stale-lock 确认/取消。

精确修复要求：提供仅测试环境可启用且不能进入生产协议面的可控 AI transport，按 `0011` 的七组 Electron 场景完成真实 main/preload/project E2E；至少断言持久化项目记录、实际发送消息、parent/latest、批注和失败不造版，而不只断言按钮可见。

### P1：已有 `previewConfig` 未接入，四层最终配置和来源不是实时 UI

main/shared/preload 已提供 `settings.previewConfig`，但 renderer 只有测试 mock 声明，从未调用。`SettingsPanel`（`App.tsx:550-679`）仅编辑各层原始 override；实时 resolved value/source 只在历史 `latestTask` 的快照中显示（`:1516-1525`），不能告诉用户下一次任务实际会用什么。保存单次 `taskConfig` 只调用 React setter（`:589-592`），不会把已准备 Prompt 标为 stale；补充事实草稿变化也没有 stale 联动。设置按钮在 active task 期间仍可操作，违反 `0011` 的冻结约束。

精确修复要求：以 `previewConfig` 返回值为唯一实时解析结果，在 project/user/task draft 或权威 revision 变化后更新全部字段的最终值和 `默认/用户/项目/单次` 来源；预览失败显示安全错误而非 renderer 自行合并。单次配置和补充事实变化必须标记 Prompt stale；active task 期间禁用影响任务语义的设置。补齐 default/user/project/task 覆盖及 Prompt stale 测试。

### P1：结构化缺项被隐藏，用户无法执行既定“检测并补充缺失信息”流程

`prompts.prepare` 的 `factCheck` 和 `risks` 已进入 reducer，但 UI 不展示 date/location/organizer/time 的 present/missing 状态。`App.tsx:906-913` 只弹出通用“缺失信息或事实冲突”确认，并立即允许把所有 risk code 作为已确认发送；用户不知道缺哪一项，也没有从该处返回纪要修正的动作。补充事实输入只应属于初稿后的 `aiReview` 分支事实链，这一点当前 API 是正确的，不应通过给 draftGeneration 注入 supplement 来绕过。

精确修复要求：Prompt 准备后显示结构化事实检查和具体缺项，明确“提示不是事实证明”，提供返回/聚焦纪要修正并重新准备的路径；初稿后 missing-info 面板再允许输入本次已确认补充并进入二次审稿。补充冲突必须明确区分并要求显式确认。E2E 覆盖完整纪要、缺地点、修正纪要和审稿补充四条路径。

### P1：批注编辑会被残留 selection 静默改锚，且没有 Monaco 锚点联动

`App.tsx:1021-1033` 只要全局 `selection` 非空，编辑任意批注就自动用该 selection 替换原 anchor；对话框 `:1614-1618` 也优先显示 selection，而不是当前批注引用。用户只是选中过另一段文本再修改批注正文，就会无提示重锚。切换 `latestVersionId` 或 Monaco model 时也没有清空 selection，旧版本选择可进入新最新版的添加/编辑路径并最终触发 main 拒绝。

同时 `MonacoEditor.tsx` 没有 comment decorations、点击批注定位或显式 re-anchor 模式，未实现 `0011` 要求的“批注区与最新版联动”和 wrapper decoration 验收。

精确修复要求：普通“编辑正文”保持原 anchor；“重新锚定”必须是独立显式命令，只消费当前最新版、当前 content hash 下的新 selection。latest/model/内容变化时清 selection。为有效锚点增加可释放的 Monaco decoration 和批注到正文定位；失效锚点只允许显式重锚。测试重复文本、残留 selection、回溯后编辑、model 切换和 decoration dispose。

## 次要发现

### P2：认证失败和四态呈现不完整

welcome/workspace 把 `notConfigured/unavailable/corrupt` 合并成“未配置/需要认证”（`App.tsx:320-323,1196-1199`）。welcome 的 set/clear 失败会关闭 modal 且不显示安全错误（`:1816-1825`）；workspace AuthDialog 的 rejected Promise 没有对话框内错误处理。应分别显示四态，失败时清空 key 的 React state/DOM 后保留安全错误和可执行恢复动作。当前 password input、无 reveal/copy、settle 后清理以及磁盘密文边界本身成立。

### P2：键盘契约只实现了一部分

菜单显示 `Ctrl+N/O`，但全局 handler `App.tsx:1109-1130` 只处理 `Ctrl+S`、`Ctrl+Shift+M` 和 F6；Ctrl+N/O 实际无效。F6 聚焦 article 容器而不是 Monaco 实例，`focusToken` 从未接线；也没有“Tab 键焦点模式”。菜单缺少 Escape/方向键行为。应按 `0011` 完成键盘命令和对应 Playwright 验收。

### P2：审稿补充草稿不会在成功后清理

`supplement` 在 Workspace 生命周期内持续保留。新版本成功后再次审稿会把已经成为父版本事实链的旧文本再次作为 `newSupplementalFacts` 提交，污染任务 provenance。应在对应任务被权威确认成功后清空本轮补充草稿，失败时保留供用户重试，并用分支 E2E 核对实际 supplement snapshot。

## 已通过部分

- Renderer 源码未发现 Node、文件系统、path、网络、credential 或浏览器持久化访问；仅通过 frozen named preload API 调用受信任能力。
- main/preload 双端 strict Schema、sender ownership、sandbox、`app://bundle`、导航/弹窗/权限拒绝和凭据加密测试继续通过。
- `ProjectViewDto` 是 renderer 项目权威快照；dirty minutes 在 CAS conflict refresh 后由 reducer 保留。
- Monaco text/diff model 使用 session/version URI，readOnly 设置正确，ResizeObserver 接线存在，editor/model/listener/worker diagnostic 均有 dispose。缺口是相应 wrapper 自动化覆盖和批注 decoration，而不是基础生命周期明显泄漏。
- 版本投影用 parent 计算 current chain，`latestVersionId` 不等同于创建时间；UI 显示 latest、父版和历史分支，设为最新版有“不删除分支”的确认。
- 只有 latest 批注按钮可用，历史回溯成为 latest 后可编辑；实际 add/edit 仍由 main 校验 version/hash/CAS。
- Prompt prepare 来自 domain/main，实际启动消息逐字使用用户编辑文本；首次编辑警告、continued/regenerated 两种 stale 选择和风险确认入口已接线。
- 九种任务状态和持久化 history 有中文状态，不显示百分比；取消文案没有承诺服务端停止或不计费。
- stale-lock 对话框只显示 observed instance id，token 不持久化，取消会丢弃 token，确认仅调用固定 `recoverOpen({confirmed:true})`。缺少的是 Electron E2E。
- 1440x900、1100x720、720x480 和 720 Prompt warning 截图已人工检查；Monaco 有可见像素且 worker 启动。720 使用可关闭的批注 drawer 覆盖工作区，未发现 body 溢出或不可关闭遮挡。

## 验证记录

- `corepack pnpm verify`：通过。unit 24 files / 307 tests；component 2 files / 6 tests；format、lint、typecheck、build 全部通过。
- `corepack pnpm test:e2e`：通过，2/2；仅覆盖安全边界和有限视觉流程，不能替代上述缺失矩阵。
- `corepack pnpm package:dir`：通过；许可证策略覆盖 10 个生产依赖，生成 `release/win-unpacked`。
- `corepack pnpm test:package`：通过，4/4；启动、fuse、asar allowlist 和 notices 均通过。
- 截图：`tests/artifacts/stage6/workspace-1440x900.png`、`workspace-1100x720.png`、`workspace-720x480.png`、`prompt-warning-720x480.png` 已检查。

## 最终结论

当前 Stage 6 不能批准。先分别关闭上述五个 P1，并补齐认证/键盘/补充草稿的 P2；然后由独立 agent 重跑完整 mock-AI Electron E2E、reload/锁恢复、三档视觉、`pnpm verify`、package smoke 和许可证复审。安全边界和打包基线无需推倒重来，但 reload resume 新 IPC 必须先经过独立编码前审查，renderer 不得持久化 session capability 或自行猜测项目路径。

## 2026-08-10 修复后独立复审

状态：**仍不批准进入 Stage 7；原 5 个 P1 和 3 个 P2 的实现缺陷已关闭，但完整日常流程 Electron E2E 尚余一个验收 blocker。** 本节取代上文对实现状态的判断；原发现保留为修复记录。

### 原 5 个 P1 的关闭结果

1. **task 对账与 reload resume 已关闭。** `projects.resumeOwned()` 使用 strict empty request，只按可信 sender 的 `ownerId` 返回唯一未 closing session；零个返回 `none`，多个安全失败，不接受 session、路径、revision 或 owner 候选。`ProjectService.resumeOwned` 进入 shared gate，refresh 后执行 session secret scan，再投影现有 opaque session。renderer 在注册 task listener 后 boot resume；运行期使用 dirty-bit coalesced hydrate，start/cancel/event settle 后均安排权威读取，revision 单调替换且 dirty minutes 在冲突后保留。active task reload E2E 证明任务不重启、不重复消费 mock step并最终只产生一个任务和一个版本。
2. **mock AI 能力和主要异常矩阵已关闭。** production `main/index.ts` 只构造 `NodeWorkerRunner`；独立 `main/e2e.ts` 才导入 `ControlledMockWorkerRunner`，且要求 unpackaged、精确 sentinel 和 strict 有界计划。E2E entry 输出到 `out-e2e`，electron-builder 只包含 `apps/desktop/out/**`。真实 main/preload/project/TaskHost E2E 已覆盖成功、active reload、safe failure、空结果、无效内容、超时、取消、批注续改、历史回溯分支、CAS 草稿、active close、归档/恢复、corrupt auth 和 stale-lock 确认/取消。
3. **四层配置预览已关闭。** renderer 调用 main-owned `settings.previewConfig`，展示模型、推理强度、渠道、字数和超时的最终值与 `默认/用户/项目/单次` 来源。task override 和 supplement 变化会标记 Prompt stale，active task 时配置层、字段和保存入口全部禁用；预览错误走安全文案。
4. **结构化缺项 UI 已关闭。** Prompt preparation 后展示日期、时间、地点和举办单位的 `present/missing` 及 evidence，明确“提示不代表事实证明”；blocking 时可返回并聚焦纪要。supplement conflict 使用独立确认文案，补充事实仍只进入初稿后的 review 分支，没有扩大 draftGeneration 事实源。
5. **批注锚点联动已关闭。** 普通编辑保留原 anchor；只有显式“重新锚定”才消费当前 selection。latest/model 卸载会清 selection；有效 latest anchors 使用可释放 Monaco decoration，批注提供定位正文/reveal。组件测试覆盖正文编辑不改锚和显式重锚，真实 E2E 覆盖选区批注、续改 Prompt 快照、新版本不继承批注以及回溯 latest 后编辑。

### 原 3 个 P2 的关闭结果

- 认证 UI 分别显示 `notConfigured/configured/unavailable/corrupt`；set/clear 失败保留 inline 安全错误并清空 key state/DOM，password/no reveal/copy 边界不变。
- `Ctrl+N/O/S`、`Ctrl+Shift+M`、F6 Monaco 聚焦、菜单 Escape/方向键和可切换的 Monaco `tabFocusMode` 已接线；组件测试覆盖 Ctrl+O 和菜单 Escape。
- review supplement 以 started task id 追踪：成功后仅在草稿仍等于该任务输入时清空，失败/取消/超时保留以便重试，避免覆盖用户随后输入。

### 0016 resume/mock 边界复核

- shared channel/request/result、preload named API 和 bridge snapshot 均为固定 strict 契约；没有通用 invoke、session 枚举、跨 owner、renderer capability 持久化或 mock 控制 channel。
- mock 计划限制 16 steps、单 content 200,000 字符、原始 JSON 256 KiB、延迟和 token 上限；runner 不保存/hash/回显 key，使用既有 WorkerRunner/AiTaskCoordinator 仲裁，不能直接写任务或版本。
- production `apps/desktop/out` 直接扫描未发现 `NW_CONTROLLED_AI_*`、controlled plan schema、mock runner、E2E entry 或 synthetic completion marker。
- 重新生成的 production `app.asar` 通过 allowlist 和全文 marker 扫描；`out-e2e`、测试、fixture 和 mock marker 均未进入便携包。production 依赖仍为 10 个，没有因 mock 新增许可证。

### 唯一剩余 blocker：完整日常流程 E2E 仍少三条关键证明

虽然 Electron E2E 已从 2 个增加到 10 个且全部通过，`tests/e2e/controlled-ai.spec.ts` 仍没有任何 `AI 二次审稿`、`准备审稿 Prompt`、`newSupplementalFacts` 或 `supplementalFacts` 操作；successful generation 用例也没有实际编辑 Prompt 后检查磁盘 artifact；other 用例只创建项目并验证 unavailable retrieval，没有成功生成 other 新闻稿。这仍不满足 `IMPLEMENTATION_PLAN.md` Stage 6 的“模拟 AI 完成全部日常流程”退出条件，以及 `0011`、`0015`、`0016` 明定的实际消息、补充事实分支和 profile 隔离验收。

精确补测要求：

1. 在 successful official 流程中确认首次警告、实际修改 Prompt、启动生成，并读取 Prompt record/content artifact，断言实际发送文本与用户最终编辑内容逐字一致、没有额外“系统原始 Prompt”副本。
2. 从 official 初稿进入 AI 二次审稿，输入明确 `newSupplementalFacts`，成功生成子版本；从 task/Prompt/version records 断言 parent、完整 branch supplemental snapshot、实际 Prompt、配置和成功版本关系一致，同时 UI 本轮补充草稿在成功后清空。再发起下一次 review 时旧补充只能来自父分支事实链，不能再次成为新的补充输入。
3. 为 other profile 提供受信 publisher 纪要并实际成功生成；读取 Prompt artifact 和版本/task records，断言 profile 为 other、publisher/目标渠道规则正确，且不存在学院默认主体或 official 专属写作假设。知识资源正式构建继续按已确认决定延期，零命中无需在本 blocker 中伪造。

### 最终验证

- `corepack pnpm verify`：通过。unit 25 files / 313 tests；component 2 files / 11 tests；format、lint、typecheck、production build 全部通过。
- `corepack pnpm test:e2e`：10/10 通过，包含独立 production build 和隔离 `out-e2e` build。
- `corepack pnpm package:dir`：通过；许可证策略覆盖 10 个 production dependencies，重新生成 production 便携目录。
- `corepack pnpm test:package`：4/4 通过；packaged 启动、fuse、asar allowlist、controlled-AI marker 排除和 notices 均通过。
- 最新 1440x900、1100x720、720x480、Prompt warning 720x480 截图已人工复看；body 无溢出，Monaco 非空且 worker 存在，窄屏批注 drawer 可关闭，没有发现新的文本越界或不可达控件。

### 修复后结论

Stage 6 的产品实现、安全边界、resume/task 收敛、Monaco/批注交互和便携生产排除已达到批准标准；但阶段退出条件明确要求完整模拟 AI 日常流程，因此在上述三条 E2E 补齐并由独立 agent 验证前，**Stage 6 仍不批准进入 Stage 7**。补测不需要修改生产协议、领域规则或 mock 边界，只应扩展现有 controlled-AI Electron E2E 和磁盘断言。

## 2026-08-10 最终 E2E 补测复审

状态：**批准 Stage 6 进入 Stage 7。** 本节取代上一节“仍不批准”的阶段结论。此次只有 `tests/e2e/controlled-ai.spec.ts` 验收测试扩展，没有产品实现、生产协议、mock 边界或 `<legacy-news-root>` 变更。原唯一 blocker 的三条证明均已真实闭合，未发现新的 blocker。

### 三条 blocker 关闭证据

1. **edited Prompt actual artifact 逐字一致。** successful official 用例真实点击首次编辑警告、确认后在 Monaco 中替换完整 Prompt，再启动任务。测试从项目 head 读取唯一 Prompt record，断言 `editedByUser=true`、存在 warning acknowledgement、stale resolution 为 current、task `promptId` 指向该唯一 record，并读取 message content artifact，严格断言其内容与用户最终编辑文本完全相等。`head.state.prompts` 为 1，未保存额外“系统原始 Prompt”副本。
2. **official 二次审稿和补充事实分支闭合。** 新用例按“初稿 -> 带 `newSupplementalFacts` 的二次审稿 -> 不填写新补充的再次审稿”产生三个成功 task/prompt/version。UI 在首个 review 成功后重新打开补充对话框并断言输入已清空。磁盘断言核对两个 review task 的 `kind/status/parentVersionId/resultVersionId`、完整 `supplementalFacts` 分支快照，两个 Prompt artifact 均只出现一次已确认补充，两个 version record 均正确引用各自 parent、sourcePromptId、taskId 且 `createdBy=aiReview`。第二次 review 从父分支继承完整事实快照，UI 没有把旧文本再次作为本轮新补充提交。
3. **other profile 实际成功生成并隔离 official 规则。** other 用例使用受信 fixture 中的 publisher，配置单次目标渠道后经过真实 main/preload/project/TaskHost 生成成功版本。磁盘断言核对 `profile=other`、task config snapshot 的 targetChannel 值与 `task` 来源、Prompt/task/version 引用关系及 latest。实际 Prompt 包含 `场景类型：other`、`发布/落款主体：青禾科普实践队` 和目标渠道，明确禁止默认套用学院主体；负向断言不存在学院发布主体和 official 专属任务指令。知识资源 unavailable 与零命中仍保持明确区分，未伪造检索记录或扩大知识库范围。

### 最终执行结果

- 三条定向 Playwright：3/3 通过。
- `corepack pnpm test:e2e`：11/11 通过；执行了独立 production build、隔离 `out-e2e` build 和完整 Electron 流程。
- `corepack pnpm verify`：通过；unit 25 files / 313 tests，component 2 files / 11 tests，format、lint、typecheck、production build 全部通过。
- 本次产品和打包输入未变化；上一轮紧邻本次补测的 `package:dir`、10 个生产依赖许可证、production `app.asar` allowlist/controlled marker 排除和 package smoke 4/4 证据继续有效。

### 最终批准

原 5 个 P1、3 个 P2、`0016` owner resume/mock 隔离，以及最后三条完整日常流程 E2E 均已关闭。Stage 6 退出条件满足，**批准主 agent 将 Stage 6 标记完成并进入 Stage 7 DOCX 样板与实际渲染验收。** Stage 7 不得把测试 controlled-AI entry、Prompt、批注、补充事实或内部任务数据带入 DOCX 导出内容。
