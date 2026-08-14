# Bug 记录

本文件记录代码复查发现的问题及处理状态。状态：`已修复` / `待修复`。

## 已修复（本次）

### BUG-001 私有打包校验路径缺少 `win-unpacked`
- 位置：`scripts/package-private-profile.mjs:159`
- electron-builder `dir` 目标输出到 `<output>\win-unpacked\`，脚本却校验 `<output>\resources\institution`，打包成功后误报 ENOENT。已改为 `win-unpacked/resources/institution`。

### BUG-002 机构 profile 身份字段未接入生成链路
- 位置：`packages/domain/src/schemas.ts`、`apps/desktop/main/bootstrap.ts`、`apps/desktop/main/project-service.ts`、`apps/desktop/main/task-host.ts`、`packages/domain/src/prompt-preparation.ts`
- 私有 profile 的 `officialPublisher`/`targetChannels`/`defaultWordCountRecommendation` 未进入 `WritingProfileSnapshot`，Prompt 的「发布/落款主体」「目标渠道」「篇幅」「主体称谓规则」使用硬编码 `示例学院`/`学院网站`/`1200`。已把三字段加入快照，`#publisher()`、默认配置和 `scene()` 改为从 profile 读取（无 profile 时回退到旧默认值，保持测试兼容）。

### BUG-003 Windows 检出时 CRLF 破坏所有哈希校验资源
- 位置：`.gitattributes`（新增）、`resources/institution/*`、`tests/fixtures/*`、`tests/golden/*`
- 无 `.gitattributes` 且 `core.autocrlf=true` 时，git 在 Windows 把 LF 检出为 CRLF，导致合成机构 profile 的 manifest 哈希全部失配（`loadInstitutionBundleFromResourcesPathV1` 失败），并影响带 sha256 的 fixtures/golden。已新增 `* text eol=lf` 并重新规范化工作树。

### BUG-004 profile 加载失败被静默吞掉
- 位置：`apps/desktop/main/bootstrap.ts`、`apps/desktop/main/diagnostics.ts`、`packages/shared/src/index.ts`
- 原来 `loadInstitutionBundleFromResourcesPathV1`/`documentStyleToTokens` 失败时静默置空，应用以无 profile 状态运行且 profile 项目可被随意写。已增加 `PROFILE_RESOURCE_INVALID` 错误码、`institution-profile-invalid` 诊断事件和启动错误弹窗。

### BUG-005 脱敏规则错误（手机号漏报 + 学号误报 + 邮箱被遮蔽）
- 位置：`packages/retrieval/src/redaction.ts`
- 手机号只匹配裸 11 位；学号规则匹配任意 10–12 位数字串（把人数/数量误脱敏）；apiKey 规则先于邮箱执行导致长本地名邮箱被截断、域名泄漏。已扩充手机号（带分隔符+座机）、学号改为必须带「学号」前缀、邮箱规则移到 apiKey 之前。

### BUG-006 缺失日期时 DOCX 解析静默删除正文/落款
- 位置：`packages/documents/src/document.ts`（`footerIndices`）
- 用户手动补日期、正文无日期行时，最后一行落款被当作日期丢弃、倒数第二行正文被提升为落款。已按「末行是否确为日期」重写 footer 判定。

## 已修复（第二轮：H1/H2/H3）

- **H1 [domain] 保存与提交之间的并发写会丢失成功生成结果** — 已在所有领域写命令（saveMinutes/updateProjectConfig/changeProjectProfile/setLatestVersion/addComment/editComment/deleteComment/recordRetrieval/recordExport）加 `assertNoActiveTask` 守卫；并移除冗余的 `targetRevision` 字段与算术校验（schema/validation/commands/task-host/fixtures 已同步清理并重新生成 fixtures）。
- **H2 [renderer] 关闭「补充信息」弹窗后任务卡死** — 按指示整体删除「补充信息」功能：移除 `supplement` 任务状态、`supplementalFacts`/`newSupplementalFacts` 字段、`provideSupplement` IPC、审稿等待与弹窗；审稿现在单次完成（`processing → reviewing → saving`）。
- **H3 [renderer] 未保存的纪要修改被静默排除** — 纪要编辑增加 800ms 防抖自动保存。

## 待修复（按严重度）

### 高
（无，已清零）

### 中

> 已修复：M4、M6、M12、M14、M23、M29、M33、M34（见 changelog）。M2、M24、M42 随「补充信息」功能删除而不再适用。

- **M1 [domain] 批注快照与实发 Prompt 不一致（`continued` 路径）** — `commands.ts:434-447`。prepare 与 start 之间新增的批注进入任务 `commentSnapshot` 但未进入实发 Prompt。
- **M2 [domain] 补充信息的时间冲突不检测** — `prompt-preparation.ts:356-380`。`labeledFacts` 缺「时间/活动时间」别名，时间冲突不触发 `SUPPLEMENT_CONFLICT`。
- **M3 [shared] `startTaskDtoSchema` 与 `preparePromptDtoSchema` 校验不一致** — `ipc.ts:528-582` vs `463-488`。start 边界接受 `retrievalReportId`/`newSupplementalFacts` 的错误组合。
- **M4 [shared] `generationConfigOverridesDtoSchema` 接受显式 `undefined`** — `ipc.ts:107-113`，领域层 `schemas.ts:101-106` 拒绝，存储后会让每次任务启动失败。
- **M5 [shared] `factOverridesDtoSchema` 绕过 `ipcObject` 原型/字节限制** — `ipc.ts:166-178`。
- **M6 [shared] 视图 DTO 比领域记录宽松** — `ipc.ts:191-200,275-301`（comment 缺 anchor.exact 校验、exportRecord 缺文件名字符校验）。
- **M7 [domain] `preparePrompt` 不校验批注锚点与父版本快照一致** — `prompt-preparation.ts:89-100`（main 层 `project-service.ts:767-776` 有补偿，但纯领域层不校验）。
- **M8 [domain] `retrievalReportSchema.hits` 无上限（>20 会使 `preparePrompt` 校验失败）** — `schemas.ts:495-505`。
- **M9 [domain] `fingerprintPromptInput` 对批注顺序敏感** — `prompt-preparation.ts:397-450` 与 `fingerprintCommentSnapshot` 不一致。
- **M10 [documents] 检索/问题清单类内容可泄漏进导出正文** — `document.ts:200` 与 `content-validation.ts:7-19` 只拒绝规范标题。
- **M11 [documents] 标题行距等样式 token 被忽略** — `document.ts:97`（title.lineSpacing 未用，`signoff.dateFormat`/`fileNameRule` 是死字段）。
- **M12 [documents] `suggestDocxFileName` 不防 Windows 保留名** — `filename.ts:4-24`（`CON`/`NUL` 等）。
- **M13 [documents] 结构审计可通过畸形 DOCX** — `audit.ts`（不校验段落级结构、未禁 `w:commentRangeStart` 等标记）。
- **M14 [documents] `looksLikeTitle` 拒绝合法标题** — `document.ts:136,139`（`20XX年` 开头或 >80 字符无前缀标题）。
- **M15 [documents] worker 未处理 `messageerror`** — `worker.ts:54-88`（clone 失败会挂到超时）。
- **M16 [documents] 审计依赖字节精确比较，升级 docx 库即全线失败** — `audit.ts:104-130`。
- **M17 [retrieval] 索引词项被替换可通过校验并改变排序** — `validation.ts:47-99`（只校验 hash/文档集/词频，不校验词项字符串）。
- **M18 [retrieval] 事实提示偏移按归一化后文本校验，原始查询会硬失败** — `report.ts:35`、`schemas.ts:523`。
- **M19 [retrieval] metadata 统计字段不重算校验** — `bundle.ts:67-92`。
- **M20 [institution] profile 兼容性按完整快照比较且无迁移路径** — `project-service.ts:1172-1193`（知识库重生成即锁死旧项目；旧项目无迁移命令）。
- **M21 [institution] 字体校验缺口** — `bundle.ts:104-109`（`restricted` 状态未拒；未校验 `documentStyle.fontFamilies ⊆ 字体清单`）。
- **M22 [institution] 敏感文本扫描跳过 manifest 及 hash 键值** — `bundle.ts:42-57,92`。
- **M23 [main] `importMinutesWithDialog` 错误码错误 + 接受非法 UTF-8** — `project-service.ts:691-706`。
- **M24 [main] 审稿补充等待无超时** — `task-host.ts:579-609`（renderer 冻结则任务永久挂起）。
- **M25 [project] `write.lock` 缺 `owner.json` 时无法通过 API 恢复** — `lock.ts:84-105,171-225`。
- **M26 [project] 崩溃遗留最终路径对象无 GC、窄窗口重试冲突** — `repository.ts:493-498,625-662,737`。
- **M27 [project] 迁移机制是空壳且向下迁移返回成功** — `migrations.ts:19-35`。
- **M28 [project] `writeCommit` 用裸 `readFile` 读内容（无 reparse/大小上限）** — `repository.ts:554-566`。
- **M29 [project] 事务 UUID schema 大小写/版本不一致** — `schemas.ts:25-30` vs `domain/schemas.ts:343-346`。
- **M30 [project] rename 后未 fsync 目录** — `atomic.ts:69-70,86-103`。
- **M31 [project] 每次保存全量重验历史（二次方 I/O）** — `repository.ts:850-908`。
- **M32 [project] 领域与仓库的大小上限不一致** — `shared/index.ts:108-116` vs `repository.ts:149-151`。
- **M33 [ai] 协调器 `phase` 可被迟到的状态迁移回退** — `execution.ts:231`。
- **M34 [ai] 非 AI 错误一律归为可重试 `NETWORK_UNAVAILABLE`** — `worker-entry.ts:49-51`、`errors.ts:50-58`。
- **M35 [ai] 绝对超时不覆盖 `preparing` 阶段** — `execution.ts:219-222`。
- **M36 [renderer] 归档项目仍可点编辑/删除/重标定批注与「设为最新版」，均报错** — `App.tsx:631-642,1895-1951`。
- **M37 [renderer] Monaco 无可见加载/错误态，挂载失败整页崩溃** — `MonacoEditor.tsx:56,155-162`。
- **M38 [renderer] 空的手动事实覆盖被静默改为 `auto`** — `App.tsx:68-78,2075-2096`。
- **M39 [renderer] 归档项目「编辑 Prompt」弹窗后仍是只读** — `App.tsx:1698-1702`。
- **M40 [renderer] `revealRequest` 未清空导致切版本后错误高亮** — `App.tsx:1884-1890`。
- **M41 [preload] 非法请求抛裸 ZodError 而非 IpcResult** — `preload/index.ts:17-23`。
- **M42 [renderer] 取消任务后补充文本泄漏到下一个审稿任务** — `App.tsx:2297-2323`。
- **M43 [retrieval] apiKey 规则仍误脱敏裸 32+ 位 ASCII（UUID/长单词）；19 位银行卡号无脱敏规则** — `redaction.ts:18`。本次已修手机号/座机/学号/邮箱遮蔽，但 `[a-z0-9_-]{32,}` 仍会把 UUID、长英文词当作凭据；银行/借记卡号（如 `622202...`）属独立类别未覆盖（为避免误伤普通数字串，暂不加裸 `\d{19}` 规则）。

## 低（记录，暂缓）
- L1 [ai] `execute()` 对并发任务抛裸 `Error` — `execution.ts:85`。
- L2 [ai] 首个命令畸形时 worker 直接关闭端口不回复 — `worker-entry.ts:23-25`。
- L3 [retrieval] 装载器 TOCTOU 无界读取 — `loader.ts:29-33`。
- L4 [retrieval] `searchRetrievalIndexV1` 对越界 posting 抛裸 Error — `search.ts:95`。

## 说明
- 上表按复查 agent 的报告整理；`M`/`H`/`L` 编号用于追踪，不代表修复顺序。
- 复查未发现问题的区域：版本不可变/最新版切换/批注绑定/任务状态机/配置优先级（domain）；路径安全/加锁互斥/崩溃屏障（project）；非流式请求与取消语义/worker 线程/API Key 脱敏（ai）；分词与 BM25 确定性/哈希确定性/报告脱敏（retrieval）；preload 最小桥接/contextIsolation/凭据与 IPC 校验（main+preload）。
