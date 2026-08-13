# 0011 Monaco 工作台与完整交互编码前独立审查

日期：2026-08-09

状态：**有条件批准，当前存在 Stage 6 编码前契约阻断项。** 工作区本身无需新的状态框架、树控件、diff 库或 Monaco React 包；但现有 Stage 5 IPC 还不能表达完整 Prompt 准备、补充事实、Prompt 过期决策、用户配置来源和任务历史。主 agent 必须先冻结并补齐本文“编码前阻断项”，再把完整 Stage 6 交给 coding agent。本文不批准用 renderer 复制领域或 Prompt 规则来绕过缺口。

## 审查范围和依据

本审查完整对齐 `AGENTS.md`、`GOAL.md`、`IMPLEMENTATION_PLAN.md`、`FUNCTION_MATRIX.md`、`PROMPT_CONTRACT.md`、`0009-electron-ipc-credentials-review.md`、`0010-electron-ipc-credentials-post-review.md`，以及当前 `apps/desktop/renderer`、`apps/desktop/preload/index.ts` 和 `packages/shared/src/ipc.ts`。

范围包括项目欢迎态、菜单、Monaco 双栏、版本树/diff、批注、Prompt 编辑、生成/缺项/审稿/续改、任务状态、配置/认证、冲突与 reload 恢复、可访问性、较小窗口和测试。DOCX 实际导出仍属于 Stage 7；知识库管理、旧项目导入、多供应商、流式和百分比进度不进入 UI。

## 必要性、复用和依赖结论

Stage 6 必要：当前 renderer 只是 Monaco worker 诊断页，普通用户尚不能使用 Stage 2-5 已有能力。实现应直接复用：

- `react@19.2.8`、`react-dom@19.2.8` 的 `useReducer`、Context、hooks 和 Error Boundary；
- `monaco-editor@0.56.0` 的 editor、model、diff editor、selection、decorations、commands 和 resize API；
- `@news-writer/shared` 的唯一 IPC DTO/错误类型和冻结 preload bridge；
- Stage 2 的版本/批注/配置领域规则、Stage 4 的九态任务机、Stage 5 的 session/revision/CAS、凭据和 task event；
- 现有 Vitest、Testing Library、Playwright Electron、package smoke 和许可证门禁。

不引入 Zustand、Redux、XState、TanStack Query、`@monaco-editor/react@4.7.0`、`react-resizable-panels@4.12.2`、树/图/diff 框架或 CSS 框架。它们会复制当前 reducer、Monaco 和领域状态，且不能解决 IPC 契约缺口。分栏使用 CSS Grid 和 Pointer/keyboard splitter；版本树使用纯投影加语义化嵌套列表，不伪装成未完整实现键盘模型的 ARIA tree。

工具栏的熟悉图标批准唯一可选的新生产依赖 `lucide-react@1.31.0`（ISC、无运行时依赖、支持 React 19），必须精确锁定、只做 named import、进入许可证及 asar/bundle 审计。若主 agent 不接受该依赖，则使用清晰的文字命令，不手绘 SVG，也不从 Monaco 私有路径导入 codicon CSS。

## 信息架构和布局冻结

### 应用状态

1. `booting`：读取 runtime/auth；显示稳定骨架，不显示假数据。
2. `welcome`：没有打开项目，首屏直接提供“新建项目”“打开项目”和 DeepSeek 认证状态；不制作营销页，不伪造没有 IPC 支持的最近项目列表。
3. `opening`：原生 dialog 或项目校验进行中，保留欢迎态并禁用重复提交。
4. `workspace`：打开一个受 main 管理的 session。
5. `fatal`：renderer 初始化/协议失败，显示安全错误、诊断 ID 和可执行的重试；不展示 stack、路径或原始 payload。

### 工作区骨架

- 顶部 40px 应用菜单：`文件`、`编辑`、`项目`；菜单使用真正的 button/menu 语义、焦点返回和 Escape 关闭。文件菜单含新建、打开、关闭、导入纪要；Stage 7 前不放置不可用的假导出命令。
- 其下是项目栏：项目名、类型、归档状态、明确的“当前最新版”标签、认证状态和当前任务状态。归档项目只读，提供“恢复项目”。
- 左侧资源区默认折叠为固定 44px rail；展开后约 232px，包含纪要、Prompt、历史版本、检索记录入口，不包含知识库管理。
- 中央保持 Monaco 双栏。左栏模式为 `纪要`、`Prompt`、`历史稿`；右栏默认显示最新版，只读，也可切为“所选历史版 vs 当前最新版”的 Monaco diff。
- 批注区默认开启。宽屏时为 300px dock；较小窗口时为带标题、关闭按钮、焦点约束和遮罩的 drawer，避免与编辑器产生无意义重叠。
- 底部状态栏只显示保存状态、当前任务阶段、当前视图版本和安全错误摘要，不显示百分比、token 速度或模型内部推理状态。

窗口继续支持当前最小 720x480。大于等于 1000px 时批注 dock；小于 1000px 时资源展开层和批注区改为互斥 drawer。中央两栏使用 `minmax(0, 1fr)`，每栏最低目标宽度 300px；720px 下仍保持双栏，不按 viewport 缩放字体。所有 splitter 有键盘增减和恢复默认尺寸命令，动态内容不得改变工具栏、标签或状态栏高度。

## 组件和状态边界

批准在 `apps/desktop/renderer/src` 内按职责拆分，不建立新的 workspace package：

```text
App
  AppController              runtime/auth/open session
  WelcomeView
  WorkspaceController        ProjectView/revision、mutation 串行化、refresh
    AppMenu
    ProjectHeader
    ResourceRail
    EditorWorkspace
      MonacoTextEditor       纪要/Prompt/历史只读 model
      MonacoVersionViewer    latest read-only 或 Monaco diff
    VersionExplorer
    CommentPane
    TaskPanel
    SettingsPanel
    AuthDialog
    ErrorRegion
```

`ProjectViewDto` 是 renderer 唯一项目权威快照。`WorkspaceController` 使用 reducer 保存：权威 view、当前左栏模式、历史选择、右栏模式、panel 开关、纪要草稿、Prompt 草稿、补充信息草稿、pending command 和安全错误。不得把领域聚合、绝对路径、credential、Node handle 或任意 IPC channel放入 state。

规则如下：

- 权威数据和本地草稿分离。纪要/Prompt 输入不能每次击键改写 `ProjectViewDto`。
- 同一 session 的 mutation 经 renderer 单队列提交，每次使用当时权威 `expectedRevision`；这只是 UX 排序，main CAS 仍是安全真源。
- `PROJECT_CONFLICT`/`PROJECT_STATE_CONFLICT` 时先 `projects.refresh`，保留未保存草稿并显示“磁盘内容/本地草稿”选择；绝不自动重放 mutation。
- task event 只触发同 session 的状态更新和节流后的权威 refresh；event 丢失、重复或乱序时以 refresh 为准。
- 切换/关闭项目、有未保存纪要或 Prompt 时必须确认；active task 时关闭项目遵循 main 的冲突结果，先显式取消并等 terminal。
- renderer reload 后重新订阅 task event，并对仍由 main 持有的 session 调用 refresh。未发送的 Prompt 草稿不写浏览器持久存储；若 reload 导致草稿丢失，应重新准备并提示，不能把 Prompt/纪要写入 `localStorage`、日志或 URL。

## Monaco 模型生命周期

- 每个逻辑文档使用稳定、非路径 URI，例如 `inmemory://news-writer/session/<opaque>/minutes`、`.../prompt/<draft>`、`.../version/<id>`；不得把项目绝对路径放入 URI。
- model 由单一 registry 持有，内容切换使用 `setModel`，组件卸载或 session 关闭时显式 dispose model/editor/diff editor/decorations。
- 纪要和已解锁 Prompt 可编辑；所有成功版本 model 永久 `readOnly`。不得提供“直接编辑最新版正文”造成绕过版本事务的错觉。
- 右侧 diff 的 original 为用户选中的历史版，modified 为当前 `latestVersionId`；两侧均只读。所选历史版与 latest 相同则回到普通 latest 视图。
- 使用 `ResizeObserver` 调用 `layout()`；禁止全局 window resize 轮询。编辑器 keybindings 不覆盖应用级保存、菜单和焦点逃离路径。

## 版本树、最新版和分支语义

版本树是 `versions` 的纯投影：按 `parentVersionId` 建 adjacency map，兄弟按高精度 `createdAt` 后以 `id` 稳定排序。显示名可用“第 N 版 · 本地时间”帮助阅读，但 ID 才是身份。

- 从 `latestVersionId` 向父节点回溯得到“当前有效链”，以连续强调样式显示；创建时间最晚的节点不得自动标成最新版。
- latest 有唯一醒目标记；历史选择和 latest 是两个独立状态，避免用户把“正在查看”误解为“已设为最新版”。
- 每个非根节点显示“基于第 N 版”；不在有效链上的节点显示“历史分支”。
- “设为最新版”必须确认其只移动指针、不删除后续版本；active task 时禁用并说明原因，main 继续权威拒绝竞态。
- 设置成功后右侧、有效链和批注权限一次性随新权威 view 更新；可以再切回旧 latest 恢复原链。
- 历史节点可以在左栏查看；“比较”在右栏开启 diff；从历史继续生成前必须先显式设为 latest，不能偷偷改变父版本。

## 批注交互冻结

批注永久按 `versionId` 分组。批注区默认跟随当前聚焦版本：latest 可新增/编辑，历史版只读并显示“设为最新版后可修改”。历史版成为 latest 后，其原批注原地恢复编辑，不复制、不迁移、不自动 resolve。

新增批注只能来自 latest 只读编辑器的非空 selection。锚点按当前领域语义生成：Monaco UTF-16 offset 的 `start/end`、`exact`、最多 256 code unit 的 prefix/suffix，以及版本正文的 `contentSha256`；`quotedText` 必须等于 `exact`。批注 decoration、点击定位、键盘“为所选文本添加批注”和可见引用文本同时存在，不能仅靠颜色表达。

版本正文不可变，因此正常项目的锚点不应漂移；renderer 仍在展示前校验 hash/range/exact/prefix/suffix。失败时显示“批注位置无法定位”，保留引用和正文，不静默绑定相似文本；续改入口被阻断，直到用户在该版本为 latest 时重新选择文本并保存 anchor。现有 API 没有删除/resolve，UI 不得虚构这些操作。新版本不显示父版本批注为待处理项。

## Prompt、缺项、审稿和续改流程

1. 编辑/导入纪要并显式保存。
2. 运行事实检查/可用时检索，显示日期、地点、主办方缺项；提示只是线索，不是事实证明。
3. 由受信任 Prompt preparation 用例按 `PROMPT_CONTRACT.md` 生成可预览 messages；renderer 不拼写作规则、历史引用或事实链。
4. Prompt 初始只读；用户选择“编辑 Prompt”时，在任何变更前确认“可能破坏事实约束和写作规范，结果由用户承担”。确认后才解除只读。用户可以任意改写，发送时不暗中补回。
5. Prompt 上游变化后标记过期。发送前必须选择“重新生成”或“继续使用当前文本”；不得自动 merge。实际发送 messages、模型、推理强度和决定由 main 原子记录。
6. 初稿成功成为首个版本。失败/取消/超时/空响应只显示任务，不创建版本。
7. missing-info 面板允许修改纪要，或为审稿明确输入“本次确认的补充事实”；冲突提示要求用户确认，补充事实不是普通批注。
8. AI 二次审稿以 latest 为父版，使用纪要、该分支确认补充和当前稿；不重新注入历史参考稿。
9. 续改要求 latest 至少一条有效批注，以 latest 正文及其届时全部批注快照生成 Prompt；新版本不继承批注。

知识资源不可用时，检索按钮进入稳定 unavailable 状态并提供“重试”；不出现添加、删除、重建或选择外部知识库入口。初稿流程允许在没有 `retrievalReportId` 时继续，并在生成态 Prompt 明确“本次未使用历史参考稿”；不可把资源故障伪装为“检索零命中”，检索记录也不能伪造。事实检查必须从知识资源加载中拆开，否则缺项流程一并不可用。

## 任务、配置和认证呈现

任务面板显示 `queued/preparing/requesting/processing/saving/succeeded/failed/cancelled/timedOut` 的中文当前状态和持久化的已发生阶段，不显示百分比。取消只在 queued 到 processing 可用；确认文案固定说明“应用将停止等待，但服务端可能继续处理并产生费用”。saving/terminal 禁用取消并解释原因。失败提供安全错误、suggested action、diagnostic ID 和用户显式“重新发起新任务”，不得自动重试。

高级设置默认折叠，但模型、推理强度、目标渠道、篇幅和超时均可控。每个最终值显示 `单次/项目/用户/默认` 来源；`medium` 说明 DeepSeek 当前按 high 执行。归档项目和 active task 期间不允许变更会影响任务语义的设置。

认证只显示 `notConfigured/configured/unavailable/corrupt`。输入 Key 使用 password field，不提供 reveal/copy；调用 settle 后立即清空 React state 和 DOM value。覆盖和清除均确认，clear 只调用 `{confirmed:true}`。错误和 toast 不包含 key、长度、前后缀、密文或路径。

## 编码前必须补齐的 IPC/DTO 契约

以下均为阻断项，不应由 Stage 6 renderer 猜测：

1. **Prompt preparation**：增加固定 `prompts.prepare` 用例，输入 session/revision、task kind、parent、可选 retrieval 和确认补充，返回有序 `system/user` messages、上游 fingerprint、缺项/风险摘要及配置预览。Prompt builder 位于纯业务/main adapter，不在 renderer。
2. **Prompt 过期决策**：`tasks.start` 携带 preparation fingerprint 和 `current | regenerated | continued` 决策；main 重算当前 fingerprint 并验证。现实现无条件写 `staleResolution:'current'`，无法满足合约。
3. **补充事实和分支事实链**：`tasks.start`/prepare 支持 `supplementalFacts`，ProjectView/prepare 能读取父版本实际事实链；当前 IPC 没有该字段，虽然 domain 已支持。
4. **Prompt/任务可追溯 DTO**：TaskView 至少增加 `promptId`、持久化 `history`、实际 model/reasoning/配置来源和必要的 supplement/retrieval 摘要；PromptView 增加 upstream/stale decision。否则 reload 后不能展示已发生阶段、实际配置或过期语义。
5. **配置层**：增加用户非敏感配置的 get/update API，ProjectView 或独立 preview 返回四层解析结果和每字段来源。当前只有项目/单次层，不能满足既定覆盖顺序。
6. **锚点输入**：VersionView 增加正文 `contentSha256`。renderer 不应重复猜测项目 artifact hash；绝不增加路径/ref DTO。
7. **事实检查与 retrieval 降级**：提供不依赖正式知识资源的 fact-check/Prompt preparation 路径，并区分 `zeroHits` 与 `RESOURCE_UNAVAILABLE`。当前 `retrieval.search` 在 main 直接固定 unavailable。
8. **锁恢复**：若首版要在 UI 完成 `PROJECT_LOCK_RECOVERY_REQUIRED`，必须先按 `0009` 增加 observed instance + `confirmed:true` 的窄恢复 API；没有 API 时 UI 只能安全报错，不能声称完整错误恢复。

所有新增 channel 继续使用 shared strict Zod Schema、固定 preload named method、sender/session/revision 校验和完整 envelope。不得增加通用 invoke、路径、文件、credential、Prompt 日志或 renderer 网络能力。

## 错误、空、加载和恢复门禁

- 每个 panel 独立有 loading/empty/error，不用全屏 spinner 抹掉已打开项目。
- dialog cancel 是正常返回，不显示错误 toast。
- 保存成功只更新权威 view；失败保留本地草稿。重复点击通过 pending command 禁用，不靠 debounce 猜提交结果。
- `RESOURCE_UNAVAILABLE`、`AUTH_REQUIRED`、`PROJECT_READ_ONLY`、`PROJECT_LOCKED/RECOVERY_REQUIRED`、`PROJECT_CONFLICT`、磁盘满、超时、取消和 protocol error 均有专门可执行文案。
- reload 后 auth 重新查询、session refresh、active task 恢复当前状态和历史；terminal task/版本以磁盘权威 view 为准。task event 不得作为唯一历史来源。
- Error Boundary 只覆盖 renderer 渲染错误，不能把项目/任务失败吞成空白页。

## 键盘和可访问性

- 全部命令可键盘操作；`Ctrl+N/O/S` 分别新建、打开、保存当前可编辑文档，`Ctrl+Shift+M` 为 selection 新增批注，`F6` 在菜单/资源/左编辑器/右编辑器/批注间循环。
- 菜单、dialog、drawer、tabs、status、alert 使用对应原生/ARIA 语义；焦点可见，dialog/drawer 关闭后返回触发器。
- 图标按钮有中文 accessible name 和 tooltip；状态、latest、branch、editable 不仅靠颜色。错误使用 `role=alert`，普通任务变化使用不过度打扰的 polite live region。
- Monaco 不吞掉 Tab 焦点逃离能力，提供明确“切换 Tab 键焦点模式”；diff/read-only 内容可由键盘和屏幕阅读器访问。
- 触控目标不小于 32px；正文和控件中文不截断，长项目名/版本名可换行或省略并提供完整 tooltip。

## 测试、E2E 和视觉验收

### 单元/组件

- reducer：boot/welcome/open/close、draft dirty、command queue、conflict refresh、event 去重、reload hydrate。
- 版本投影：线性、分支、回溯 latest、同时间稳定排序、孤儿/非法 DTO 安全失败。
- Prompt：首次编辑前警告、取消不解锁、过期两种显式选择、发送逐字一致、不保存原始副本。
- 批注：UTF-16 offset、重复文本、prefix/suffix、失效锚点、历史只读、回溯后可编辑、新版不继承。
- 任务/配置/auth：九态文案无 `%`，取消计费提示，来源展示，key settle 后 DOM/state 清空，安全错误不泄露内容。
- Monaco wrapper：model/worker/editor/diff dispose、readOnly、resize、selection decoration 和 focus command。

### Electron E2E（mock AI，真实 main/preload/project）

1. 新建 official 项目、编辑/导入纪要、缺项提示、Prompt 预览/警告编辑、生成初稿、二次审稿。
2. 对 latest 选区批注并续改；验证父批注快照、新版无批注、历史批注只读。
3. 回溯历史为 latest、修改当时批注、再次续改形成新分支；切回原 latest 并验证原链恢复；diff 双侧正确。
4. other 项目不出现学院默认主体；无检索命中可生成；知识资源 unavailable 有区别且无管理入口。
5. queued 到 processing 取消及计费文案；saving 禁止取消；失败/超时/空响应版本数、latest 和旧正文不变。
6. active task 页面 reload 后 refresh 恢复；conflict 保留草稿；关闭 active project、归档/恢复、认证缺失/损坏和安全错误路径。
7. 伪造 IPC、renderer Node/path/credential 探针继续失败，bridge key 只增加本文批准的固定方法。

### 视觉门禁

Playwright 对 1440x900、1100x720 和 720x480 截图；检查 welcome、普通 workspace、资源展开、批注 dock/drawer、diff、长中文、loading、empty、error、cancel、branch tree 和 Prompt warning dialog。断言无元素遮挡、文本溢出、空白 Monaco、动态布局跳动或不可达操作；同时做 Monaco 可见像素/worker 检查。浅色高对比为首版基线，不做装饰性渐变、嵌套卡片或单色大面积营销布局。

全部实现需通过 `pnpm format:check`、lint、typecheck、unit/component、Electron E2E、`package:dir`、package smoke、许可证和 asar allowlist。UI 完成后必须由另一独立 review agent 检查业务语义、安全边界、视觉和重复实现。

## Coding agent 准入范围和最终结论

主 agent 先批准并安排本文 IPC/DTO 阻断项的小范围契约实现及独立复审；关闭后，coding agent 可在 renderer 实现本文组件、状态、Monaco 模型、样式和测试，并只对 main/preload/shared 做已冻结的 named API 接线。

禁止：在 renderer 构建 Prompt/事实链/版本关系真源，直接访问 Node/fs/path/credential/network，保存 Prompt 到浏览器持久存储，添加知识库管理、DOCX 假入口、最近项目假数据、百分比进度、自动重试、直接编辑成功版本或扩大供应商配置。

总体产品决策之间没有不可执行冲突；当前阻断来自“完整 Stage 6 交互要求”与“现有最小 IPC 只能提交已完成 Prompt/缺少若干可追溯字段”之间的接口缺口。补齐上述窄契约后，现有 Electron + React + TypeScript + Monaco 架构可执行，且不需要改变安全模型或引入重量级 UI 框架。
