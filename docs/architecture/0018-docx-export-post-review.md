# 0018 Stage 7 DOCX 导出编码后独立复审

日期：2026-08-10

状态：**实现暂不批准，Stage 7 不得关闭。** 当前主流程和三份结构样例基本成立，但仍有两个实现阻断项、若干冻结验收缺口，且实际视觉门禁明确未通过。本次只写本文，未修改产品实现，也未修改只读原项目 `<legacy-news-root>`。

## 审查范围

本次对照 `AGENTS.md`、`GOAL.md`、`IMPLEMENTATION_PLAN.md`、`0017-docx-export-review.md` 和 `documents` skill，完整检查了：

- `packages/documents` 的 parser、A4 token、字体槽位、DOCX builder、scrub、结构 audit、worker 协议；
- shared/domain 导出 Schema、main/preload/renderer 的固定 IPC、dialog、gate、revision、历史版本与归档语义；
- 同目录临时文件、`wx`、file-handle sync、原子替换重试、readback、失败记录和 commit 对账；
- `docx`/`jszip` 依赖、32 个生产依赖许可证、便携 asar 内容与 QA 产物；
- 三份现有 QA DOCX 的 ZIP/OOXML、文本、元数据和禁用部件；现有渲染记录中的 LibreOffice、Word 和字体前提。

## Findings

### P1-1：document worker 以 0 码退出但未响应时，导出永久 pending

位置：`packages/documents/src/worker.ts:64`。

`exit` handler 只在 `code !== 0` 时调用 `finish()`；若 worker 在发送 response 前正常退出，Promise 不 resolve/reject，worker 仍留在集合中，ProjectService 持有全局 gate，renderer 会永久显示导出中。worker entry 对无效请求直接 `return`，也能进入这一类无响应路径。

复现：用 `data:text/javascript,void 0` 作为 `NodeDocumentWorkerRunner` entry 调用 `generate()`，250 ms 后结果仍为 `still-pending-after-250ms`。当前没有生成超时兜底。

修复要求：任何在合法 response 前发生的 `exit`（包括 code 0）都必须以 `DOCUMENT_GENERATION_FAILED` settle；worker 对无效 request 必须响应失败或以非零码退出；增加 clean-exit、invalid-message、error、shutdown-race 测试。可再增加有界生成超时，但不能用超时替代正确的 exit 仲裁。

### P1-2：导出记录已进入 DTO，但 renderer 没有任何可查看入口

位置：`apps/desktop/renderer/src/App.tsx:1032`、`apps/desktop/renderer/src/App.tsx:1532`。

renderer 能导出所选历史版本并在状态栏显示本次文件名，但从未读取或渲染 `project.exportRecords`。这不满足 `0017` 冻结的“导出历史可查看”，也使 failed/succeeded 记录、对应 version、时间和模板版本对用户不可见。

复现：全仓搜索 renderer 中 `exportRecords` 无命中；组件测试仅声明 `exportWithDialog` mock，没有点击导出、取消、失败或历史展示测试。

修复要求：增加非特权的导出历史视图，至少显示版本、状态、完成时间、文件名和安全错误；不得显示路径。覆盖成功、失败、取消、任意历史版本和归档项目。

### P2-1：结构 audit 是不完整 denylist，尚未达到冻结的关系/部件 allowlist

位置：`packages/documents/src/audit.ts:3`。

当前能拒绝 comments、people、media、customXml、custom properties、VBA、embeddings、部分修订和 external relationship，但没有严格限定允许的 ZIP parts、relationship types 和 content types；也未拒绝 `activeX`、`altChunk`、OLE relationship、字段、`w:vanish`/`w:webHidden` 等全部隐藏内容。现有 `hiddenText` 检查不是 Word 常用隐藏 run 标记。token audit 也只抽查部分页边距、字体槽位和段落属性。

修复要求：按 `0017` 建立明确 parts/content-types/relationships allowlist；完整检查四字体槽位、A4 全部 margin、lineRule、keepNext、widowControl、snapToGrid、无字段/隐藏文本/对象。测试必须注入每类禁止部件证明会失败。

### P2-2：成功记录 commit 对账只比较 export ID，且没有要求的 fault-injection 测试

位置：`apps/desktop/main/project-service.ts:228`。

实现顺序正确：先发布并 readback，再提交 succeeded record；commit 抛错后 refresh，记录存在即返回，否则报告“文件已写入但记录未保存”。但对账只判断同一 ID 存在，没有比较权威记录的 version、fileName、templateVersion、hash 和 length；`0017` 要求按 export ID/record 内容对账。

现有 ProjectService 导出测试只有 success、dialog cancel、worker failure，没有 commit pre-HEAD、post-HEAD、refresh failure 或 failed-record commit failure 注入。

修复要求：对账完整 succeeded record；补 pre-HEAD（文件保留、无成功记录、部分成功错误）和 post-HEAD（refresh 后按成功返回且不追加 failed）故障注入。原始安全错误仍须优先于 failed-record 保存错误。

### P2-3：便携包只证明 worker 文件存在，没有从 asar 实际启动 document worker

位置：`tests/package/smoke.spec.ts:146`。

`document-worker.js` 已正确作为 sibling entry 打入 `app.asar`，源码/dist runner 的真实生成也通过；但 package smoke 只检查条目 allowlist，启动便携 App 后只调用 runtime API，没有执行 DOCX worker。asar 路径、worker_threads 与打包 chunks 的组合仍未被运行证明。

修复要求：增加不打开原生 save dialog 的受控 main/package smoke，仅在测试构建中调用 packaged `NodeDocumentWorkerRunner` 生成合成 `NewsDocument` 并执行结构 audit；不得向产品 bridge 暴露通用 worker 或文件能力。

### P2-4：worker 请求自身没有 16 MiB 字节级上限

位置：`packages/documents/src/contracts.ts:11`、`packages/documents/src/worker.ts:23`。

产品入口的 `parseNewsDocument()` 已用 UTF-8 bytes 限制 16 MiB，因此当前 ProjectService 正常路径有界；但公开 runner 只验证字段字符数，理论上可接受远大于 16 MiB 的结构化消息，不符合 worker 两端独立有界的冻结要求。

修复要求：runner 和 worker entry 都对 canonical request 或全部文本 UTF-8 byte length 做 16 MiB 硬限制，并测试多字节中文边界。

## 符合项

- parser 使用指定成功版本正文，不读取批注、Prompt、检索、任务或认证；标题、正文、落款、真实日历日期和文件名规则基本符合 `0017`。
- builder 生成 A4 `11906 x 16838 DXA`，四边距、页眉/页脚距离、四个命名样式、字号、行距、缩进、对齐、keepNext、widowControl、snapToGrid 和四字体槽位均出现在三份现有产物中。
- core metadata 的 creator/lastModifiedBy 固定为 `News Writer`；三份产物无 rsid、字段、隐藏 run、外链、comments、custom properties、media、宏或 embedding，可见文本与 fixture 一致。
- main 的 save dialog 在 gate 外；选定路径后在 gate 内复核 owner、revision、version/hash。允许任意成功历史版本，`recordExport()` 不要求 active，因此归档项目也可导出。
- preload 仅暴露固定 `documents.exportWithDialog`；DTO 不含 path 或 Buffer，记录只投影安全末级文件名和元数据。
- 文件发布使用目标同目录随机 sibling temp、`wx`、完整写入、handle sync、close、Windows 有界重试、最终 readback hash/length 和 temp 清理；成功前不写 succeeded record。
- `docx@9.7.1` 和 `jszip@3.10.1` 均精确锁定，无原生扩展。许可证报告共有 32 个生产依赖，`THIRD-PARTY-NOTICES.txt` 包含全部 32 个；`jszip` 选择 MIT、`pako` 的 MIT AND Zlib、`sax` 的 BlueOak-1.0.0 均已有显式政策条目。

## jszip 边界结论

`0017` 原文“不选直接 jszip”需要做窄范围修订，而不是要求删除当前 scrub。检查 `docx@9.7.1` 后确认：它即使未配置批注和 custom properties，也固定生成空 `word/comments.xml`、`word/_rels/comments.xml.rels` 和 `docProps/custom.xml`；公开 `snapToGrid` 选项属于 run properties，不能表达本模板要求的 paragraph `w:pPr/w:snapToGrid`。因此，使用 JSZip 删除固定空部件、清理对应 content-type/relationship，并补单一 paragraph token 是有必要的兼容层，不等同于手写正文 OOXML。

批准边界应改为：JSZip 只允许对 `docx` 产物执行版本固定、allowlist 驱动、可审计的 scrub/token patch；不得创建正文、样式主体、关系图或任意模板系统。所有 patch 前后都必须严格 audit。当前实现的用途符合该方向，但 P2-1 的 allowlist 仍需补齐。

## 实际验证

- 定向 unit：`packages/documents`、`document-publish`、`ProjectService`，3 files / 45 tests 全部通过。
- 三份现有 QA DOCX：`GD-SINGLE` 8474 bytes、`GD-MULTI` 9563 bytes、`GD-LONG-TITLE` 8606 bytes；CRC/结构 audit 均通过，分别为 19 parts，可见文本节点 6/15/6。
- 源码 dist worker：真实启动并生成 8474-byte `GD-SINGLE`，结构 audit 通过。
- 便携 package smoke：4/4 通过；证明 App 可启动、fuse 正确、asar payload allowlist 和 notices 存在，但未实启 asar document worker。
- 许可证只读核对：32/32 生产依赖均有 notices，无缺项。

## 视觉验收

视觉门禁仍为 **未通过**，不得关闭 Stage 7：

- 本机没有 `soffice`，documents skill renderer 以 `FileNotFoundError [WinError 2]` 失败；
- Word 16.0 build 16.0.20228 的隐藏只读 COM 打开持续阻塞，不能据此宣称 Word 通过；
- 未安装“方正小标宋简体”和“仿宋_GB2312”，不能把字体替换视为目标模板结果；
- 当前 PDF/PNG 页数为 0，没有任何逐页 100% 视觉检查证据。

必须在安装并记录目标字体版本的 Windows QA 环境，用正式 TypeScript builder 重新生成三份样例，通过 LibreOffice 或可控 Word 实际渲染，并逐页检查长标题、分页、中文 glyph、两字缩进、1.5 倍行距、落款/日期同页和空白页。Word 仍阻塞时只能继续标记待验收，不能再次以进程存在或文件可打开代替视觉结论。

## 最终结论

当前实现不可批准为 Stage 8 的稳定依赖。先修复 P1-1 和 P1-2，再关闭 P2-1 至 P2-4 并完成独立复审；结构/事务/asar worker 门禁通过后可以标记“实现批准、视觉待验收”。只有三份样例完成实际渲染和逐页人工检查后，Stage 7 才能正式关闭。

---

## 2026-08-11 最新修复独立复审

状态：**仍不批准实现；Stage 7 视觉待验收且不得关闭。** 先前 P1 已全部修复，P2-2 和 P2-4 已关闭，asar 内 worker 也已实际运行；但 P2-1 的严格审计仍有可复现缺口，P2-3 的实现方式把测试启动分支带入正式便携包。以下结论对上文同名 finding 的状态作最终更新。

### 修复状态矩阵

| 原 finding | 最新状态 | 复审核验 |
| --- | --- | --- |
| P1-1 worker 0 码无响应永久 pending | 已关闭 | 任意 response 前 `exit` 均 reject；增加 120 秒有界超时，并覆盖 clean exit、invalid response、worker error、shutdown race。 |
| P1-2 renderer 无导出历史 | 已关闭 | 资源树新增“导出记录”，显示版本、状态、文件名、时间、模板和安全失败信息；组件测试覆盖列表、取消、失败、历史版本成功导出且不出现路径。 |
| P2-1 strict audit 不完整 | **未关闭** | parts/content-types/relationships、隐藏 token、字体槽位和页面 token 已显著加强，但前置 scrub 和允许 story parts 仍存在下述反例。 |
| P2-2 commit 对账及 fault injection | 已关闭 | 对账完整序列化 record；测试覆盖 pre-HEAD、post-HEAD lost response、字段不匹配、refresh failure、failed-record commit failure。 |
| P2-3 asar worker 未实启 | 行为已验证，打包边界未关闭 | package smoke 确实从 `app.asar` 启动 worker 并 audit 输出；但正式 main 内置测试环境变量分支，见下述 finding。 |
| P2-4 worker 无独立 16 MiB 字节界 | 已关闭 | runner 和 worker entry 均使用 canonical JSON UTF-8 byte limit；覆盖中文边界和真实 worker 超限拒绝。 |

### P2-1a：前置兼容审计仍会接受并删除非空 comment

位置：`packages/documents/src/audit.ts` 的 `auditDocxCompatibilitySource()`。

`0017a-jszip-narrow-revision.md` 只允许删除 `docx@9.7.1` 固定生成的**空** comments/custom parts。当前 comment 检查只拒绝部分 ID，`w:id="0"` 和 `w:id="-1"` 不匹配；它也没有对 patch 前的 content-types、relationships、token、可见文本和隐私执行与后置 audit 同等级的检查。

复现：向兼容源的 `word/comments.xml` 写入 `w:id="0"` 且正文为 `SHOULD_NOT_BE_DELETED`，保留另外两个兼容部件后调用 `auditDocxCompatibilitySource()`，实际结果为 `COMPATIBILITY_AUDIT_ACCEPTED_NONEMPTY_COMMENT_ID_0`。后续 scrub 会删除该真实 comment，违反 0017a 边界。

修复要求：用结构化 XML 检查或无歧义规则要求 comments 根下不存在任何 `w:comment`，custom properties 根下不存在任何 property；patch 前执行严格 source allowlist，并只将三个已核验为空的兼容部件作为明确例外。

### P2-1b：后置 audit 不检查允许 story part 的可见文本

位置：`packages/documents/src/audit.ts` 的 `auditNewsDocx()`。

parts allowlist 必须允许 `footnotes.xml` 和 `endnotes.xml`，因为 `docx@9.7.1` 固定生成必要 separator parts；但当前“可见文本精确等于源稿”只提取 `word/document.xml`。向 `word/footnotes.xml` 增加普通 `w:t` 不触发禁止 token、关系或 content-type 检查，也不参与文本比较。

复现：向正式产物的 `word/footnotes.xml` 注入 `HIDDEN_INTERNAL_TEXT` 后调用 `auditNewsDocx()`，实际结果为 `POST_AUDIT_ACCEPTED_HIDDEN_FOOTNOTE_TEXT`。

修复要求：验证 footnotes/endnotes 只包含库固定的 separator/continuationSeparator 结构和无用户文本；或把所有允许 story parts 的可见文本纳入精确内容断言。增加 footnote、endnote 和其他允许非主文档 part 的注入测试。

### P2-3a：asar smoke 测试分支被打入正式便携包

位置：`apps/desktop/main/index.ts`、`tests/package/smoke.spec.ts`。

`NW_PACKAGE_DOCUMENT_WORKER_SMOKE=1` 会让正式 `News Writer.exe` 跳过正常启动，在内存生成合成文档、输出 marker 后退出。这确实证明了最终 asar worker 可运行，但偏离上文冻结的“仅在测试构建中”边界，也与既有便携包排除 controlled test hook 的纪律不一致。

只读扫描正式 `release/win-unpacked/resources/app.asar` 可见 `NW_PACKAGE_DOCUMENT_WORKER_SMOKE`、`NW_DOCUMENT_WORKER_SMOKE_OK` 和合成测试标题。package allowlist 当前没有拒绝这些新 marker，因此测试对自身引入的正式测试钩子形成例外。

修复要求：主 agent 必须二选一并留档：

1. 使用不进入最终交付 asar 的专用 package-smoke 构建证明 worker，再重新生成无测试分支的最终便携目录；或
2. 明确修订打包安全边界，批准这个无持久化、无 renderer/IPC 暴露的只读自检模式，并让 package policy 精确允许唯一分支及固定输出，同时解释为何它不是可扩展测试后门。

在完成其中之一前，不批准正式便携实现。

### 最新门禁结果

- `pnpm verify`：通过；unit `28 files / 349 tests`，component `2 files / 15 tests`，format、lint、typecheck、build 全绿。
- Electron E2E：`11/11` 通过；包含安全 preload、完整 AI 流程、分支、冲突、恢复和多视口 UI，但导出交互主要由 component tests 覆盖。
- package smoke：`5/5` 通过；其中 asar document worker 真实启动并完成 audit。
- 三份现有 QA DOCX：`GD-SINGLE` 8474 bytes、`GD-MULTI` 9563 bytes、`GD-LONG-TITLE` 8606 bytes；最新 strict audit 均通过，每份 15 个非目录 parts。
- 许可证：32 个生产依赖，`THIRD-PARTY-NOTICES.txt` 缺项为 0。
- 便携排除：未发现 `.doc/.docx/.pdf/.pptx/.py/.png` 或 `.env` 文件；但上文 P2-3a 的测试代码和 marker 位于 asar JavaScript 中。

### 视觉状态不变

本次未获得新的视觉证据。环境仍无 `soffice`，Word COM 仍阻塞，且未安装“方正小标宋简体”和“仿宋_GB2312”；PDF/PNG 仍为 0 页。因此不得声称 LibreOffice、Word 或字体视觉验收通过。

### 最新最终结论

先前 P1 已关闭，核心导出事务、renderer 和 worker 实现已经接近可批准状态；但 P2-1a、P2-1b 和 P2-3a 尚未关闭，所以本次不能给出“实现批准、Stage 7 视觉待验收”。修复并独立复审这三项后，若无新 blocker，可将状态提升为“实现批准、Stage 7 视觉待验收”；只有目标字体和实际逐页渲染验收完成后，才能批准 Stage 7 完全关闭。

---

## 2026-08-11 A/B 修复最终独立复审

状态：**实现仍不批准；Stage 7 视觉待验收且不得关闭。** P2-1a 和 P2-3a 已关闭，但 P2-1b 的独立恶意注入仍可绕过当前后置审计。

### 已关闭项

- **P2-1a 已关闭。** `auditDocxCompatibilitySource()` 现在要求三个兼容部件齐全，并将 `word/comments.xml` 与已知的 `docx@9.7.1` 空 comments 模板逐字比较；独立注入 `w:id="0"` 且包含正文的 comment 后，审计以 `DOCX source compatibility parts are not empty` 拒绝。该正文不会再被当作空兼容部件静默 scrub。
- **P2-3a 已关闭。** package smoke 已使用独立的 `apps/desktop/main/package-smoke.ts` 和专用测试构建；正式 `apps/desktop/main/index.ts` 只启动正常桌面入口。对 `release/win-unpacked/resources/app.asar` 内全部文本型 payload 扫描 `NW_PACKAGE_DOCUMENT_WORKER_SMOKE`、`NW_DOCUMENT_WORKER_SMOKE_OK` 和合成测试标题，命中数为 0。专用 package-smoke asar 仍实际启动 document worker 并审计结果，不向正式包带入测试入口。

### 仍阻断：P2-1b story part 普通文本未被严格审计

当前 `auditNewsDocx()` 虽会合并扫描全部 XML/relationship 并拒绝隐藏 run、字段、对象和外部关系等禁用 token，但“可见文本精确等于源稿”的比较仍只提取 `word/document.xml` 的 `w:t`。它没有要求 `word/footnotes.xml` 和 `word/endnotes.xml` 保持库生成的固定 separator-only 结构，也没有把这些 story part 的普通 `w:t` 纳入精确文本断言。

独立复现：向正式 builder 产物的 `word/footnotes.xml` 增加 `w:id="1"` 的 footnote，并在普通 run 中写入 `STRICT_REJECT_HIDDEN_STORY_TEXT`；重新打包后调用最新 `auditNewsDocx()`，结果仍为 `ACCEPTED`。该注入不需要 `w:vanish`、`w:webHidden` 或其他禁用 token，因此现有 denylist 无法覆盖。

关闭要求：对 footnotes/endnotes 使用结构化 XML 检查或版本固定的规范化比较，只允许 `docx@9.7.1` 必需的 separator/continuationSeparator 内容且不允许用户文本；同时增加 footnote 和 endnote 普通 `w:t` 注入回归测试。修复后必须重新执行同一独立反例，确认审计明确拒绝。

### 本轮门禁证据

- `pnpm verify`：通过；unit `28 files / 350 tests`，component `2 files / 15 tests`，format、lint、typecheck 和 build 均通过。
- Electron E2E：`11/11` 通过。
- package smoke：`5/5` 通过；专用测试包从 asar 实际启动 document worker。
- 生产依赖许可：32 项通过策略检查，notices 缺失 0。
- 三份 QA DOCX 当前 strict audit 均通过：`GD-SINGLE` 8474 bytes、`GD-MULTI` 9563 bytes、`GD-LONG-TITLE` 8606 bytes；每份均为 15 个非目录 parts，可见文本节点分别为 6/15/6。由于上面的 P2-1b 说明 strict audit 尚有盲区，这些结果只能证明三份现有样例未触发现有规则，不能替代恶意 story-part 注入门禁。

### 视觉状态仍未通过

本轮仍无新的实际渲染证据：环境无 `soffice`，Word COM 仍阻塞，未安装“方正小标宋简体”和“仿宋_GB2312”，测试产物中 PDF/PNG 仍为 0 页。因此不得声称 LibreOffice、Word、目标字体或逐页视觉验收通过，也不得关闭 Stage 7 完整验收。

### 最终结论

P2-1a 与 test-only package smoke 边界已正确修复，其余既有实现门禁保持通过；但 P2-1b 仍是可复现的内容泄漏审计缺口，因此本次**不能**给出“实现批准、Stage 7 视觉待验收”。修复并独立复审 P2-1b 后，若无新 blocker，可将状态提升为“实现批准、Stage 7 视觉待验收”；只有在目标字体齐备的 Windows QA 环境完成实际渲染和逐页人工检查后，Stage 7 才能完整关闭。

---

## 2026-08-11 story-part 修复最终复审

状态：**实现批准、Stage 7 视觉待验收。Stage 7 完整验收不得关闭。** 上一节唯一剩余 blocker P2-1b 已修复并通过独立恶意注入复现；本轮未发现新的实现 blocker。

### P2-1b 已关闭

`auditNewsDocx()` 现在对 `word/footnotes.xml` 和 `word/endnotes.xml` 分别执行版本固定的精确结构比较，只接受 `docx@9.7.1` 生成的 separator 与 continuationSeparator 两个固定 note，拒绝普通 note、`w:t`、隐藏 token、额外属性或其他结构变化。该规则与最新 `0017a-jszip-narrow-revision.md` 的窄范围修订一致：JSZip 仍只用于固定兼容部件 scrub 和单一 paragraph token patch，没有扩大为通用 OOXML 编辑器。

独立复现结果：

- 向 `word/footnotes.xml` 注入普通 `w:id="1"` footnote 和 `INDEPENDENT_FOOTNOTE_TEXT`，以 `DOCX note stories are not the fixed empty structures` 拒绝。
- 向 `word/endnotes.xml` 注入普通 `w:id="1"` endnote 和 `INDEPENDENT_ENDNOTE_TEXT`，以同一固定结构错误拒绝。
- 向 footnote 注入 `w:vanish` 隐藏文本、向 endnote 注入 `w:webHidden` 隐藏文本，均先由 forbidden OOXML 审计拒绝。
- `word/comments.xml` 的 `w:id="0"` 非空正文注入仍以 `DOCX source compatibility parts are not empty` 拒绝，P2-1a 未回归。

因此，固定 notes 精确比较与全 XML 禁用 token 扫描形成互补：普通 story-part 文本和显式隐藏内容均不能进入成功 DOCX。

### 打包边界与门禁

- production `release/win-unpacked/resources/app.asar` 的全部文本 payload 对 `NW_PACKAGE_DOCUMENT_WORKER_SMOKE`、`NW_DOCUMENT_WORKER_SMOKE_OK` 和专用合成测试标题扫描命中 0。
- production asar 内正式 `apps/desktop/out/main/document-worker.js` 已包含最新固定 note-story 审计；独立 package-smoke 构建继续从其专用 asar 实际启动 document worker，不向正式入口加入测试分支。
- `pnpm verify`：通过；unit `28 files / 354 tests`、component `2 files / 15 tests`，format、lint、typecheck 和 build 均通过。
- Electron E2E：`11/11` 通过。
- package smoke：`5/5` 通过。
- 生产依赖许可：32 项通过策略检查，notices 缺失 0。
- 三份 QA DOCX 通过最新 strict audit：`GD-SINGLE` 8474 bytes、`GD-MULTI` 9563 bytes、`GD-LONG-TITLE` 8606 bytes；每份 15 个非目录 parts，可见文本节点分别为 6/15/6，notes 均精确匹配固定空结构。

### 视觉门禁仍未通过

实现批准不等于 Stage 7 完整关闭。本环境仍无 `soffice`，Word COM 仍阻塞，未安装“方正小标宋简体”和“仿宋_GB2312”，且 PDF/PNG 仍为 0 页；因此没有目标字体下的实际分页、长标题、中文 glyph、两字缩进、1.5 倍行距、落款/日期同页或空白页视觉证据。

最终结论：**实现批准、Stage 7 视觉待验收。** 当前实现可以作为后续阶段的稳定依赖，但只有在目标字体齐备的 Windows QA 环境完成三份样例的实际渲染与逐页人工检查后，才能批准并关闭 Stage 7 完整验收。

## 2026-08-11 实际视觉验收关闭

状态：**Stage 7 完成。**

在 Windows 11 x64（`10.0.26200`）上注册并确认目标字体 `FangSong_GB2312` 与 `FZXiaoBiaoSong-B05S` 后，使用 LibreOffice `26.2.5.2` 和 bundled `render_docx.py` 重新生成并渲染三份 TypeScript builder 样例。输出位于 `tests/artifacts/stage7/render/2026-08-11/checked7/`：`GD-SINGLE` 1 页、`GD-MULTI` 2 页、`GD-LONG-TITLE` 1 页，三份 PDF 均为 A4。

四张逐页 PNG 已按 100% 检查：标题字体/字号/居中和长标题换行、正文两端对齐/首行缩进/1.5 倍行距、跨页连续性、标题与首段关系、落款和日期同页右对齐均通过。`GD-MULTI` 的行尾全角逗号由正文段落 `w:overflowPunct w:val="1"` 正确保留，三份 PDF 与 fixture 逐字符一致；未发现裁切、重叠、缺字、空白页、字体替换或隐藏内部文本。QA 记录详见 `docs/qa/stage7-docx-render.md`。

最终门禁保持通过：`pnpm verify`（unit 355/355、component 15/15）、Electron E2E 11/11、package smoke 5/5、许可证 32/32，生产便携目录不含 QA 渲染中间产物。

### 最终快速源代码与 fixture 确认

再次只读核对 `auditNewsDocx()`、四个 note-story 注入测试、三份 Markdown fixture 与三份黄金 DOCX 后，无新增 finding：允许部件集合与精确数量断言共同保证 footnotes/endnotes 必须存在，随后两者分别与固定 separator XML 精确比较；普通及隐藏 footnote/endnote 四类反例均有回归覆盖。该段原“视觉待验收”结论已由上文 `2026-08-11 实际视觉验收关闭` 记录取代；最终状态为：**Stage 7 完成**。
