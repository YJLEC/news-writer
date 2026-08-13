# 0013 Stage 6 Prompt preparation 前置契约独立复审

日期：2026-08-10

状态：**不批准作为 Stage 6 UI 的稳定依赖。** 当前实现的 IPC、凭据隔离、用户配置存储和任务原子入队边界总体成立，但 Prompt 渲染存在事实边界矛盾、动态资料未完整转义、批注顺序不符合既定合约，且 V1 消息结构和规定的验收矩阵没有被冻结。以下阻断项修复并经独立复审前，不应让 renderer 依赖本批契约。

## 审查范围

本次只读检查 `AGENTS.md`、`GOAL.md`、`docs/architecture/0011-monaco-workspace-review.md`、`0012-prompt-preparation-review.md`、`docs/baseline/PROMPT_CONTRACT.md`，以及本批 `packages/domain`、`packages/shared`、`apps/desktop/main`、`apps/desktop/preload` 实现与测试。未修改 `<legacy-news-root>`，未修改产品实现。

## 阻断发现

### P1：续改 Prompt 否定已实际注入的分支补充，并把 other 专属纪要结构用于 official

`packages/domain/src/prompt-preparation.ts:487` 的续改事实边界固定写入“活动纪要中的[活动内容]”和“本次没有补充信息”，不区分 `profile`，也不区分 `supplement` 是否存在。与此同时，同一个 Prompt 前面会正常注入 `branchSupplementalFacts`。因此 official 续改会被要求依赖其纪要中未必存在的 `[活动内容]`，任何继承补充的续改都会同时告诉模型“有补充”和“没有补充”。这违反 `PROMPT_CONTRACT.md` 第 41、331、353 行和 `0012` 的完整分支事实快照要求。

可复现结果：以 `profile=official`、`branchSupplementalFacts="活动时间：09:00"` 准备 `commentRevision`，返回消息同时包含该补充、`本次没有补充信息` 和 `活动纪要中的[活动内容]`。现有 revision golden 只有 other 且无补充，未覆盖此路径。

精确修复要求：按 `profile` 生成 official/other 各自的事实边界；按解析后的完整 `supplement` 明确写“纪要和已确认补充是事实来源”或稳定的“本次无补充信息”，不得出现与 `<supplement>` 内容矛盾的指令。增加 official+继承补充、other+继承补充、无补充三类语义负向测试。

### P1：事实检查 evidence 绕过动态资料统一转义

`packages/domain/src/prompt-preparation.ts:404-415` 的 `factLines` 直接渲染从纪要/补充提取的 evidence；generation/review 在 `:448`、`:467` 把结果插入 Prompt 时没有调用 `escapeMaterial`。例如地点 `A&B <inject>` 在 `<minutes>` 中已转义，却在“已识别地点”中再次以原始 `A&B <inject>` 出现。该重复出口可以重新引入标签样式文本，违反 `0012` 第 37 行“动态资料统一转义 `&`、`<`、`>`”的冻结要求。

精确修复要求：事实提示的每个动态 evidence 在唯一渲染边界进行同一套转义，且不能双重转义。测试必须断言最终完整 Prompt 不包含对应原始 `&`/`<`/`>` 片段，而不只是断言某个资料块中存在转义后的副本；generation 和 review 都要覆盖。

### P1：续改批注按创建时间排序，不按正文锚点排序

`apps/desktop/main/project-service.ts:327-340` 按 `createdAt/id` 组织准备态批注；`packages/domain/src/commands.ts:406-415` 也按相同顺序冻结任务快照。`PROMPT_CONTRACT.md` 第 329 行冻结的是“按正文锚点顺序；同一锚点按创建顺序，仍相同则稳定内部顺序”。用户后补充前文批注时，当前实现会把前文批注排在后文批注之后，Prompt、fingerprint 和任务快照都会稳定地保存错误顺序。

精确修复要求：在领域层定义并复用一个批注快照排序规则，至少依次比较 `anchor.start`、`anchor.end`、`createdAt`、`id`；prepare 和 `queueTask` 必须使用同一结果，避免重复排序实现漂移。增加“创建顺序与正文顺序相反”和“同锚点同时间”的测试，并断言 Prompt、trace hash、持久化 task snapshot 三者一致。

### P2：V1 的单一 user message 没有被 Schema 冻结

`packages/domain/src/prompt-preparation.ts:204-215` 接受空数组、任意数量及 `system` 角色；`packages/shared/src/ipc.ts:356-384` 和 `:386-432` 允许 1 到 16 条 `system | user` 消息。实际 builder 当前只返回一条 user，但 `0012` 第 37 行明确冻结 V1 为“恰好一条 user”，未来增加 system 必须先修订合约和 golden。受控 renderer 当前可以通过 `tasks.start` 提交额外 system 消息并将其持久化、发送，这扩大了已批准协议面。

精确修复要求：Prompt preparation 返回 Schema、prepare DTO 和 start DTO 统一约束为恰好一条 `{ role: 'user', content }`；若保留领域存储的未来多消息能力，也不能在 V1 IPC 暴露。增加空数组、多 user、system、未知字段的负向测试。

### P1：`0012` 明定的关键验收矩阵尚未实现

现有定向测试覆盖四份 golden、一次 current 启动、单个补充冲突和单个 unavailable retrieval，但没有覆盖：

- `continued`、`regenerated` 及三种裁决的完整接受/拒绝矩阵；
- 分支回溯只继承 parent task 的完整 supplemental snapshot，且不串入同级、后代或创建时间更晚分支；
- prepare 后权威纪要、配置、批注、parent/latest 或检索引用变化时 start 的重算冲突；
- other publisher 的受信任解析成功与缺失硬阻断；
- default/user/project/task 四层值与 source 在 prepare、task snapshot、worker input 中的一致性；
- prepare 不写 Prompt/Task/artifact 的完整断言，以及 start 一次事务同时落 Prompt、Task、supplement、retrieval、upstream；
- 用户配置 main/IPC 层的 secret 硬阻断、全局 gate 线性化和 CAS（当前仅服务类有 2 个测试）。

这些不是建议性覆盖，而是 `0012` 第 77 行的实现门禁。修复前三项实现问题时必须补齐上述测试，不能仅更新 golden 使错误输出通过。

## 已批准部分

- Prompt builder 位于纯 TypeScript domain，无 Electron、文件系统、网络或新依赖；prepare 本身不持久化。
- fingerprint 使用稳定对象键排序、数组保序和单一末尾 LF，覆盖 minutes、parent、完整 supplement、新补充、retrieval、批注、规则版本和完整 resolved config，未包含路径、时间、session/task/prompt ID 或 secret。
- `resolveBranchFacts` 从明确 parent version 的 task provenance 读取快照，没有按全局创建时间汇总分支。
- `ProjectService.preparePromptWithinGate` 校验 owner/session/revision、active、parent=latest、retrieval 归属、批注正文锚点、other publisher 和 secret；other publisher 缺失会硬阻断。
- `TaskHost.start` 在同一 gate 内重算 preparation/fingerprint，校验 stale decision、风险确认、DeepSeek model 和 secret；Prompt 与 Task 在一个 project commit 中入队，失败不会创建版本，transport 使用与持久化相同的 `input.messages`。
- 用户配置使用 userData 下独立 `config.json`、strict 非敏感 Schema、revision CAS、临时文件+sync+rename，API Key 不进入该 envelope；ProjectService 的 update 受全局线性化 gate 和 secret 检查保护。
- main/preload 使用固定命名 IPC、双端 Schema 校验和冻结 API；项目能力继续受 sender/session owner 约束，全局 settings 只接受受信任窗口 sender。

`ProjectService.#view` 与 `TaskHost.#taskView` 当前重复投影 task trace/config/retrieval/comment summary。两处暂时行为一致，但 Stage 6 UI 开始依赖这些字段前应复用一个 main 内部 projector 或用等价一致性测试锁定，避免后续字段只更新一处。本项不是单独阻断项。

## 验证结果

- 定向：`corepack pnpm exec vitest run --project unit packages/domain/src/prompt-preparation.test.ts packages/shared/src/ipc.test.ts apps/desktop/main/project-service.test.ts apps/desktop/main/task-host.test.ts apps/desktop/main/user-config-service.test.ts`，5 files、71 tests 全部通过。
- 全量：`corepack pnpm verify` 通过；unit 24 files、277 tests，component 1 file、1 test，format、lint、typecheck 和 production build 均通过。
- 额外只读复现确认：完整 Prompt 中事实 evidence 保留原始 `A&B <inject>`；带继承补充的 official revision 同时包含补充、否定补充的事实边界和 other 专属章节假设；`promptPreparationSchema` 接受 `messages: []`。

全绿结果证明现有断言和构建稳定，不证明上述未覆盖契约成立。完成阻断修复、补齐验收矩阵并再次通过独立 post-review 后，方可批准 Stage 6 Monaco 工作台依赖本批 API。

## 2026-08-10 修复后独立复审

状态：**批准 Stage 6 renderer 依赖本批前置契约。** 本节取代本文顶部的原“不批准”结论；原发现保留为修复记录。本次复审未发现剩余 blocker，未修改产品实现或 `<legacy-news-root>`。

### 原阻断项关闭证据

- 续改事实边界已在 `packages/domain/src/prompt-preparation.ts` 按 `official/other` 和完整分支 supplement 分流。official 不再引用 `[活动内容]/[活动背景]/[其余信息]`，有补充时不再输出“没有补充信息”。测试覆盖 official/other 有继承补充以及无补充状态的正向和负向断言。
- `factLines` 现在在唯一 evidence 渲染边界调用 `escapeMaterial`。generation 和 review 测试同时断言原始 `A&B <inject>` 不存在、转义文本存在且没有双重转义。
- `orderCommentSnapshots` 成为 domain 内共用排序规则，依次使用 `anchor.start`、`anchor.end`、高精度 `createdAt` 和 `id`；prepare、fingerprint 和 `queueTask` 使用同一规则。测试覆盖正文顺序与创建顺序相反、同锚点稳定顺序、混合精度时间戳和任务快照顺序。
- domain `promptPreparationSchema`、shared `promptPreparationDtoSchema` 和 `startTaskDtoSchema` 均冻结为恰好一条 `user` message。IPC 负向测试拒绝空数组、多条 user、system 和消息未知字段。

### 验收矩阵复核

- `current/continued/regenerated` 有有效接受测试和无效关系拒绝矩阵；拒绝路径断言不保存 Prompt/Task 且不启动 worker。
- 权威 minutes、project config、retrieval 引用、comment snapshot 和 parent/latest 变化均由 start 重算或状态校验拒绝；没有 renderer 提交 current fingerprint 的旁路。
- 分支测试实际生成同一根版本的 A/B 两条分支，再从选定 parent 准备，证明只继承该 parent task 的完整 supplement，且切换 latest 后旧 parent 启动被拒绝。
- default/user/project/task 四层配置的 values 和 sources 在 prepare 与 task snapshot 一致；worker input 使用同一 model、reasoning effort 和 max words。
- other publisher 的受信任解析与缺失硬阻断均有 main service 测试。prepare 测试同时检查 aggregate 不变和 `content/prompts` 无 artifact。
- current 启动测试核对实际 transport、Prompt artifact、Prompt upstream、Task config/minutes/supplement/retrieval/comment trace 与 project view 投影；单次 project commit 继续同时写入 Prompt、Task 和相关 artifact，后续失败/取消路径不造成功版本。
- 用户配置在 service 和 ProjectService 层覆盖 strict Schema、userData 原子保存、revision CAS、secret 硬阻断及与项目 mutation 共用全局 gate 的线性化。固定 IPC、preload named API、sender 信任和 session ownership 边界未出现回归。

`ProjectService.#view` 与 `TaskHost.#taskView` 的 task 投影仍有少量重复，但新增投影一致性断言已锁定关键 trace/config 字段；它不再构成本阶段阻断。

### 最终验证

- 定向：`corepack pnpm exec vitest run --project unit packages/domain/src/prompt-preparation.test.ts packages/domain/src/index.test.ts packages/shared/src/ipc.test.ts apps/desktop/main/project-service.test.ts apps/desktop/main/task-host.test.ts apps/desktop/main/user-config-service.test.ts`，6 files、112 tests 全部通过。
- 全量：`corepack pnpm verify` 通过；unit 24 files、302 tests，component 1 file、1 test，`format:check`、lint、typecheck 和 production build 全部通过。

结论：`0012` 的实现门禁已满足，Stage 6 Monaco 工作台可以使用当前 Prompt preparation、配置、TaskHost、named preload API 和严格 IPC 契约。renderer 仍不得自行拼接 Prompt、解析分支事实、计算权威 fingerprint 或绕过 main 的风险和 secret 校验。
