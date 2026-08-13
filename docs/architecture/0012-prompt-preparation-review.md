# Stage 6 Prompt preparation 编码前审查

## 结论

批准增加一个纯 TypeScript 模块 `packages/domain/src/prompt-preparation.ts`，作为 Stage 6 UI 之前唯一的 Prompt 准备用例。它只接收已校验、已读取的值并返回不可变结果；不依赖 Electron、文件系统、网络、凭据或项目路径。main 负责读取 artifact、解析 session/revision、调用该模块并持久化结果，renderer 只展示和编辑返回的 messages。

不需要新开源依赖。现有 Zod、配置解析、领域 Schema 和黄金文本已足够；模板引擎会扩大转义和隐式求值面，状态机/工作流库会重复现有 task 状态机。SHA-256 使用调用方注入的 `sha256Utf8(text)` port，生产适配器复用 Node `createHash`，纯测试可注入等价实现；不得手写密码算法。模块内部固定一个小型 canonical JSON 编码器（对象键排序、数组保序、UTF-8、单一末尾 LF），不要跨层复用 retrieval 私有模块。

## 冻结的模块合约

公开入口保持窄且确定：

```ts
preparePrompt(input: PromptPreparationInput, deps: { sha256Utf8(text: string): Sha256 }): PromptPreparation
fingerprintPromptInput(input: PromptFingerprintInput, deps: ...): Sha256
resolveBranchFacts(project: ProjectAggregateV1, parentVersionId: VersionId | null): ResolvedBranchFacts
checkMissingFacts(input: { minutes: string; supplementalFacts?: string }): FactCheckSummary
```

`PromptPreparationInput` 必须包含 `schemaVersion: 1`、`kind`、`profile`、规范化后的 minutes snapshot、显式 parent version snapshot、当前分支补充事实、可选本次新增补充、可选 retrieval report snapshot、续改批注快照、四层配置和已版本化写作规则。所有联合类型按 `kind` 严格区分：初稿无 parent/补充/批注；审稿有 parent、可选新增补充、无 retrieval/批注；续改有 parent、至少一条有效批注、无 retrieval。未知字段和不兼容组合必须失败。

返回 `PromptPreparation`：

```ts
{
  schemaVersion: 1;
  purpose: TaskKind;
  messages: readonly { role: 'system' | 'user'; content: string }[];
  inputFingerprint: Sha256;
  resolvedConfig: ResolvedGenerationConfigSnapshot;
  factCheck: FactCheckSummary;
  risks: readonly PromptRisk[];
  trace: PromptPreparationTrace;
}
```

V1 固定 `messages` 为恰好一条 `user`，内容逐字匹配四份 `tests/golden/prompts/*.txt`，使用 LF 和单一末尾换行。不得生成隐藏 `system` 指令。数组和角色语义继续保留；未来增加 `system` 必须先修订 Prompt 合约、预览和 golden，并确保实际发送快照逐条一致。动态资料统一转义 `&`、`<`、`>`，不截断、不写路径、分数、内部 ID、模型或推理强度。

## Fingerprint 与过期裁决

fingerprint 是 canonical JSON preimage 的 SHA-256，只覆盖生成该 Prompt 的语义输入：合约/规则版本、kind/profile、minutes revision 与内容 hash、parent version ID 与正文 hash、解析后的完整分支补充事实 hash、本次补充 hash、generation 所用 retrieval report ID/knowledge version/engine version/有序 hit 内容 hash、续改有序批注的 anchor/quote/body hash，以及完整 resolved config values/sources。不得包含 session/project/task/prompt ID、时间、路径、API Key 或 messages 本身。

`prompts.prepare` 返回的 `inputFingerprint` 是编辑器当前文本所对应的 `promptInputFingerprint`。`tasks.start` 时 main 从当前项目权威状态和同一 prepare 参数重算 `currentInputFingerprint`，再按现有 `promptUpstreamDecisionSchema` 唯一判定：

- `current`：两 hash 相同，且无 previous hash；
- `continued`：两 hash 不同，用户明确继续旧编辑文本，且无 previous hash；
- `regenerated`：两 hash 相同，并带不同的 `previousPromptInputFingerprint`，表示用户已舍弃旧稿并重新 prepare。

renderer 不能提交 `currentInputFingerprint`。不满足上述关系、引用已不存在、parent 不再是 latest、revision 变化、或声明 `current` 但 hash 已变化时，main 返回 conflict；不得自动合并或重写 messages。无论哪种裁决，持久化和 transport 使用的都必须是 start 请求中经安全检查后的同一有序 messages。

## 补充事实分支链与缺项

每个非初稿 task 的 `supplementalFacts` 语义冻结为“该任务实际采用的完整、规范化分支事实快照”，不是仅本次 delta。准备审稿/续改时，只读取 parent version 的 `sourcePromptId/taskId` 所属 task 快照，再按 `继承快照 -> 本次用户确认补充` 顺序组成新快照；根初稿为空。切换 latest 后从该 parent 重新解析，绝不按创建时间汇总祖先、同级、后代或其他分支。空状态稳定渲染“本次无补充信息”；不得去重、改写或推断用户文本。若补充与纪要存在被检查器识别的冲突，prepare 返回阻断 risk，确认前不可 start。

缺项检查是模块内独立纯函数，始终针对规范化 minutes 加已解析补充运行，至少返回 `date/location/organizer` 的 `present | missing`、可显示证据和阻断级别。它不能读取 knowledge bundle、knowledge version、retrieval hit 或资源可用状态；retrieval 只影响 generation 的历史风格章节。知识资源 unavailable、未运行检索和真实 zero hits 必须是三个不同 trace 状态，但三者均不得让缺项检查不可用。没有 retrieval 时 generation 仍生成稳定的“本次未使用历史参考稿”；zero hits 使用“未检索到历史参考稿”。

## 配置与来源

准备和启动都必须调用现有 `resolveGenerationConfig(default, user, project, task)`；main 提供可信 default/user/project，renderer 只能提交 task overrides。返回和持久化完整 `ResolvedGenerationConfigSnapshot`，UI 直接显示每字段 `default | user | project | task`，不得自行重算。Prompt 文本只使用解析后的 `profile/targetChannel/maxWords` 及场景主体；model、reasoning、timeout 不进入文本，但仍进入 fingerprint 和 task snapshot，以保证预览、启动和历史追溯使用同一整套配置。

other 场景的 publisher 必须在 prepare 前由受信任解析器得到明确值；无法从最终配置/纪要场景段解析时硬阻断。official 使用批准的主体规则，并保持外部主办时学院为参加方。不得把各配置层或冲突值同时交给模型。

## IPC prepare/start

新增固定 channel `prompts.prepare`：请求为严格 DTO `{sessionId, expectedRevision, kind, parentVersionId, retrievalReportId?, newSupplementalFacts?, taskConfig?}`；响应为 `PromptPreparationDto`。main 校验 sender/session/revision、项目 active、kind/parent/latest 关系、retrieval 归属、批注 anchor、内容上限和 secret，再读取内容调用纯模块。响应不得包含 artifact ref/path。

修改 `tasks.start`：请求保留最终 `messages/editedByUser/editWarningAcknowledged`，并携带上述 prepare 参数、`promptInputFingerprint`、`staleResolution` 和 regenerated 时的 previous hash；删除由 renderer 提交的 `currentInputFingerprint`。main 重做完整 prepare/fingerprint 校验、验证风险确认和 resolved config，随后一次事务写入 Prompt、Task、完整补充快照、retrieval 引用与 upstream decision。`editedByUser === editWarningAcknowledged` 规则继续保留；secret 是无条件硬阻断。准备成功不落盘，只有 start 创建 Prompt/Task。

## 可追溯 DTO

`PromptPreparationTrace`/历史 view 只暴露复现所需逻辑身份和 hash，不暴露路径或正文副本：minutes revision/hash、parent version ID/content hash、supplement `{present, sha256}`、retrieval `{state: notUsed | zeroHits | used | unavailable, reportId?, knowledgeVersion?, hitCount}`、comment `{count, sha256}`、rule version、input fingerprint 和 resolved config。

`PromptViewDto` 增加 `upstream`；`TaskViewDto` 增加 `promptId`、完整 `history`、`configSnapshot`、minutes revision/hash、supplement summary、retrieval summary 和 comment snapshot summary；`VersionViewDto` 增加 `contentSha256`。实际 supplement 文本只在 prepare 的可见 Prompt 中出现，历史 view 默认只给存在性/hash，避免再造一份可编辑事实源。所有 DTO 继续 strict Zod、结构化字节上限和固定 named preload method。

## 实现门禁

coding agent 只可实现上述纯模块、窄 main adapter、shared IPC/DTO 和对应接线；不得在 renderer 拼 Prompt、解析事实链或计算权威 fingerprint。验收必须覆盖四份 golden、消息顺序/LF/转义、三种 stale decision、分支回溯、补充冲突、无知识资源仍可缺项检查、配置来源、prepare 不持久化、start 原子快照、secret 阻断和 actual transport 逐字一致。实现后需独立 post-review，再作为 Stage 6 UI 依赖。
