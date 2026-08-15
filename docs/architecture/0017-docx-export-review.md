# 0017 Stage 7 DOCX 导出编码前独立审查

日期：2026-08-10

状态：**有条件批准编码。** DOCX 导出是首版完整工作流的必要模块；现有领域导出记录、项目事务、固定 IPC、安全 preload、全局串行 gate 和合成正文 fixture 足以复用。批准以本文冻结的正文解析、A4 模板、外部文件原子发布、记录仲裁、纯 TypeScript 依赖和实际渲染门禁全部落实为前提。本文未修改产品实现，也未修改只读原项目 `<legacy-news-root>`。

## 审查范围和证据

本次完整对照 `AGENTS.md`、`GOAL.md`、`IMPLEMENTATION_PLAN.md`、`docs/baseline/FUNCTION_MATRIX.md`、`GOLDEN_FIXTURES_PLAN.md`、`GOLDEN_FIXTURES_REVIEW.md`、`tests/fixtures/MANIFEST.md`、Stage 2/5/6 架构与复审记录、当前 `domain/project/shared/main/preload/renderer` 契约和 `packages/documents` 占位实现。

原项目只读检查了 `scripts/news_common.py` 的标题、日期、文件名和 `python-docx` 行为，`data/training_rules.txt`、用户手册、现有学院稿/其他稿 DOCX 及源稿。原实现实际生成 Letter 页面，标题 22 pt，正文 16 pt，首行 32 pt，但没有显式 1.5 倍行距和段前/后距；它还会静默退化为无正式样式的手写 OOXML。现有生成 DOCX 的 core properties 含本机修改者，不能成为新产品的隐私或元数据基线。

`documents` skill 只影响开发验收：其 `render_docx.py`、bundled Python 和 LibreOffice 可以用于 DOCX 到 PNG 的 QA，但产品、asar 和便携目录必须保持纯 TypeScript，不能包含或启动 Python、LibreOffice sidecar 或 skill 脚本。

## 必要性、现有复用和模块边界

`packages/documents` 当前只有包名常量，无法满足 GOAL 的最终 DOCX。应在该既有 package 内实现三项纯能力，不新增顶层 package：

1. 把不可变版本正文解析为受限 `NewsDocument`；
2. 由冻结模板生成 DOCX bytes；
3. 生成确定性的建议文件名并提供结构审计辅助。

直接复用：

- `VersionRecord.contentRef` 和 `ProjectSession.readText()` 作为唯一正文来源；
- 现有 `ExportRecord`、`recordExport()`、`ProjectSession.commit()` 和项目追加/原子 head 事务；
- `ProjectService` 的 owner-bound session、revision CAS、secret 检查和 shared `SerialLinearizationGate`；
- fixed invoke channel、main/preload 双端 strict Zod、`IpcResult` 和可信 sender 检查；
- Electron `dialog.showSaveDialog()`；
- Stage 1 的 `GD-SINGLE`、`GD-MULTI`、`GD-LONG-TITLE` 合成文本。

禁止另建导出数据库、模板引擎、通用文件 API、renderer 路径 API、历史文件扫描器或第二套项目事务。`packages/documents` 不读取项目目录，不知道 Prompt、批注、任务、检索、API Key 或 Electron；main 只向它传解析后的新闻稿结构。

## 纯 JavaScript DOCX 方案

批准固定评估时的 `docx@9.7.1`：MIT，Node `>=10`，纯 JavaScript，无原生扩展；其段落、run、样式、section、页面尺寸和 `Packer.toBuffer()` 能覆盖首版无图片新闻稿。coding agent 应精确锁版本，执行 API/打包 smoke 后才可落锁；不得用宽松 semver。

不选：

- `officegen@0.6.5`：接口和依赖面更老、更宽，没有必要；
- `docxtemplater@3.69.3`：解决模板占位填充，不是本项目确定性样式生成的更窄方案，部分高级能力另有商业模块；
- `pizzip` 或直接 `jszip`：会把实现退回手写 OOXML；
- 原项目 `python-docx` 和最小 OOXML fallback：违反纯 TypeScript，且原 fallback 会静默输出不合格文档。

引入后必须重新生成 `THIRD-PARTY-NOTICES.txt`，让 `licenses:check` 覆盖 `docx` 及全部生产传递依赖。任何许可证不在现有 allowlist 的传递包先独立复核，不得跳过。`npmRebuild=false/nodeGypRebuild=false` 应继续成立。

## 冻结的正文解析契约

公开输入只允许：

```ts
interface NewsDocument {
  title: string;
  bodyParagraphs: readonly string[];
  signOff: string;
  dateText: string;
  dateStamp: string; // YYYYMMDD，仅用于建议文件名
}
```

解析规则：

1. 输入必须来自用户指定且已成功生成的 `versionId` 对应 `contentRef`；允许任意历史分支版本，不要求等于 `latestVersionId`，也不按创建时间猜最新版。
2. 校验 content ref 的既有 hash/长度后，去 UTF-8 BOM，统一 CRLF/CR 为 LF，去首尾空白；不做事实补写、AI 清理或 Markdown 渲染。
3. 第一个非空逻辑行是标题。只允许移除一个 ATX 标题前缀 `#{1,6} + 空格`、成对的整行 `**`，或显式 `标题：/题目：`；不得把“以下是”“分析”“问题清单”等包装当标题。
4. 最后一个非空逻辑行必须是有效中文日期 `20YY年M月D日`，并通过真实日历校验；倒数第二个非空逻辑行必须是非空落款。落款对 official 和 other 一视同仁，不硬编码“示例学院”。
5. 标题与落款之间至少有一个非空正文段。正文以空行或独立逻辑行形成段落，移除行首尾空白但不改写字词、标点、段落顺序或事实。
6. 标题最长 500 字符；单段最长 20,000 字符；正文最多 2,000 段，总输入不得超过现有版本 artifact 上限。NUL、控制字符、孤立 surrogate 和不可表示内容显式拒绝。
7. 再次调用领域 `validateNewsContent()`；问题清单、内部说明、Prompt 回显、Markdown fence、待补充占位或空正文均返回 `DOCUMENT_CONTENT_INVALID`，不生成“尽力而为”的 DOCX。
8. 导出绝不读取或合并 `comments`、Prompt messages、supplemental facts、retrieval report、task history、配置或认证。批注仍永久保留在项目中，但不是 `NewsDocument` 字段。

上述严格尾部结构是对原脚本“任何匹配日期行/仅特定学院名右对齐”的修正。若成功版本缺标题、落款或日期，UI 应明确说明该版本不符合导出结构，并引导用户从该版本生成修正版；不得用当前日期、项目名、纪要或配置补造内容。

## 正式模板和精确 token

冻结模板版本：`standard_business_brief.zh_news_a4.v1`。这是 `documents` skill 的 `standard_business_brief` **命名覆盖**，不是混用 preset。中国中文新闻送审采用 A4 更合适；共享 preset 的 US Letter 被明确覆盖。原项目生成出的 Letter 只是 `python-docx` 默认值，不是培训规则，不能凌驾于目标样板。

| 区域 | 精确 token |
| --- | --- |
| 页面 | A4 纵向，`11906 x 16838 DXA` |
| 页边距 | 上/下 `1440 DXA`（1 in），左/右 `1800 DXA`（1.25 in），正文宽 `8306 DXA` |
| 页眉/页脚距离 | 各 `720 DXA`；不创建可见页眉、页脚或页码 |
| 颜色/装饰 | 全文纯黑；无边框、底纹、横线、水印、表格、图片、目录和封面 |
| 标题样式 | `NewsTitle`；方正小标宋简体，22 pt/二号，非粗体，居中；单倍行距 `240 auto`；段前/后 `0`；无缩进；`keepNext=true`、`widowControl=true`、`snapToGrid=false` |
| 正文样式 | `NewsBody`；仿宋_GB2312，16 pt/三号，黑色，两端对齐；1.5 倍行距 `360 auto`；段前/后 `0`；首行 `640 DXA`（两个 16 pt 汉字）；`widowControl=true`、`snapToGrid=false` |
| 落款样式 | `NewsSignOff`；同正文字体字号，右对齐，1.5 倍行距，段前/后 `0`，无首行缩进，`snapToGrid=true`（对齐文档网格，对齐 BUPT-QMUL 送审标准） |
| 日期样式 | `NewsDate`；同正文字体字号，右对齐，1.5 倍行距，段前/后 `0`，无首行缩进，`widowControl=true`、`snapToGrid=true` |
| 分页 | 自动分页；标题不得与首段分离，落款不得与日期分离；不插入人为分页或空段落制造间距 |
| 字体槽位 | `ascii`、`hAnsi`、`eastAsia`、`cs` 全部显式写入对应目标字体，不依赖 Word theme/default |
| 元数据 | creator/lastModifiedBy 固定为 `News Writer`，title 可为稿件标题；不得写 Windows 用户名、项目路径、Prompt、version/task/comment ID、API Key 或诊断信息；无 comments、tracked changes、custom properties |

方正小标宋简体和仿宋_GB2312并非所有 Windows 10/11 镜像都保证安装，也不能在没有字体授权的情况下随便携目录分发。编码可以精确声明字体并继续，但“所有机器像素完全一致”不是仅靠 DOCX 可兑现的承诺。Stage 7 视觉黄金机必须安装并记录这两种字体及版本；最终无开发环境验收也必须先做字体存在性记录。若交付机缺字库，必须由用户另行批准采用 Windows 自带替代字体或提供可分发授权，不能让 Word 静默替换后仍宣称通过精确视觉验收。这是当前唯一尚待交付环境关闭的外部前提，不是 Electron/TypeScript 架构冲突。

## 文件名契约

建议名来自已经解析的 `dateStamp + title`，不从纪要路径、系统日期或创建时间推断：

```text
YYYYMMDD清理后标题.docx
```

标题先移除已有日期前缀；Windows 禁止字符 `< > : " / \\ | ? *`、C0 控制字符替换为 `_`，连续空白折叠，去首尾空格/点/下划线，按 Unicode code point 截到 90 字。清理为空即拒绝，不能回退为含糊的“新闻稿”。日期前缀保证不会形成 `CON/PRN/AUX/NUL/COMn/LPTn` 保留名。最终 component 必须不超过 255 字符，扩展名强制为小写 `.docx`。

文件名只提供可读送审习惯，不编码“第 N 版”“最新版”或分支关系。用户可在 save dialog 中修改名称；`versionId` 和成功 `ExportRecord` 才是身份依据。重名覆盖只在原生 Windows 对话框确认后发生，不自动加序号、不扫描旧 outputs，也不重命名其他导出。

## IPC、dialog 和 renderer 契约

只增加一个 fixed invoke channel，例如：

```ts
documents.exportWithDialog({ sessionId, expectedRevision, versionId })
```

请求采用 strict Schema，`versionId` 可指向项目中的任意成功版本。preload 只暴露命名方法，不暴露 `showSaveDialog`、路径、Buffer、Node/fs、任意 channel 或通用写文件 API。main 从可信 sender 取得 owner，校验 session/revision/version/hash，再构建建议名并显示仅限 DOCX 的 save dialog；renderer 永远不提交或接收目标绝对路径。

取消 dialog 返回 `{cancelled:true}`，不创建记录、不生成文件、不增加项目 revision。成功结果返回最新 `ProjectViewDto` 和本次无路径 `ExportRecordViewDto`；Project view 增加有界 `exportRecords` 摘要，使导出历史可查看。DTO 只包含 id、versionId、时间、fileName、status、templateVersion、byteLength/hash 或安全错误；现有 `destinationDisplay` 最多保存经清理的末级目录显示名，首版可省略，绝不保存盘符、父路径或用户名。

UI 在当前查看版本提供带下载图标的“导出 DOCX”，明确显示将导出的版本；历史版本同样可导出，不需要先设为最新版。活动任务期间可禁用导出以减少用户混淆，但领域能力不得强制 latest。归档项目仍允许只读导出并记录结果，因为归档只改变项目状态。无版本、损坏版本或结构无效时按钮禁用或返回明确安全错误。

共享错误模型新增并测试 `DOCUMENT_CONTENT_INVALID`、`DOCUMENT_GENERATION_FAILED`、`EXPORT_PATH_INVALID`、`EXPORT_NOT_WRITABLE`、`EXPORT_DISK_FULL`、`EXPORT_ATOMIC_REPLACE_FAILED`、`EXPORT_IO_ERROR`。不得把路径、原始系统异常或稿件内容塞进 safe error、日志或 renderer toast。

## 外部文件与项目记录的事务语义

save dialog 不占用 shared gate；用户选定路径后，所有权威检查、DOCX 生成、外部写入和项目记录提交进入现有全局 gate。若 dialog 期间 revision 改变，则在任何外部写入前返回冲突，让用户重试。

冻结顺序：

1. 在 gate 内重新校验 owner/session/expectedRevision/version content，记录 `attemptedAt`；
2. 把 `NewsDocument` 发送给专用 Node Worker Thread，worker 两端校验有界消息，用 `docx` 生成 bytes；renderer/main event loop 不执行压缩；
3. 拒绝空 bytes 或超过 16 MiB 的无图片 DOCX，计算 SHA-256；
4. 在目标同目录以随机 sibling temp、`wx`、完整写入、file-handle sync、close 后原子 replace；对 Windows `EACCES/EPERM/EBUSY` 做与项目原子替换同等级的有界重试；
5. 从最终目标重新读取并校验长度/hash；旧文件在 publish 成功前保持不变，失败清理 temp；
6. 外部文件确认成功后，以同一 export ID 调用正式 `recordExport()` 和 `ProjectSession.commit()` 追加 succeeded record；
7. 若生成或外部写入失败，旧目标保持不变，并尽力提交一个 failed record；记录本身失败不能覆盖原始安全错误。

外部目标和项目目录可能位于不同卷，无法获得单一 ACID 事务。正确权威顺序是“文件成功后记录成功”，不能先写成功记录。若外部文件已经发布，而项目 commit 在 HEAD 前真正失败，绝不删除或回滚用户文件；返回“文件已写入，但导出记录保存失败”的安全错误并要求 refresh。若 commit 抛错但可能已越过 HEAD，先 refresh 并按 export ID/record hash 对账：记录存在即按成功返回，不存在才报告部分成功。该异常必须有 fault-injection 测试。

worker crash、生成异常、取消 App、磁盘满、目标被 Word 占用、目标目录消失、跨设备/非原子语义、readback hash 不符均不得产生 succeeded record。App shutdown 必须等待或有界终止文档 worker并清理 temp；不能留下被标为成功的空 DOCX。

## 结构、隐私和内容纯净门禁

每个生成文件至少做以下自动检查：

- ZIP/OOXML 可解析，主 document、styles、settings、core/app properties 和关系均符合 allowlist；
- section、四个命名样式和精确 token 均存在，不依赖模板默认值；
- 可见文本精确等于 `{title, bodyParagraphs, signOff, dateText}`，顺序一致；
- 不存在 comments、people、tracked revisions、customXml/custom properties、外链、宏、OLE、图片、附件、隐藏文本或字段；
- 所有 XML/relationship/core properties 扫描不到测试注入的 Prompt、批注、retrieval、task、supplement、API key、绝对路径和 secret sentinel；
- filename、record hash/length/template/app version 与磁盘文件一致。

不得把二进制 DOCX hash 当唯一黄金，因为 ZIP metadata/库版本可能造成无意义变化。黄金应包含规范化 OOXML/token 结构期望、提取文本和固定渲染 PNG；任何黄金更新都要人工解释视觉变化。

## 实际渲染和视觉黄金门禁

编码完成后才批准创建 Stage 7 黄金。开发 QA 可调用 documents skill 的 bundled Python `render_docx.py` 和 LibreOffice，但脚本、Python、LibreOffice、PDF/PNG 中间物均不得进入产品依赖或 `release/win-unpacked`。

自动门禁：

1. 在记录了 Windows、LibreOffice、目标字体版本和 DPI 的固定 QA 环境，用正式 TypeScript builder 生成 GD-SINGLE、GD-MULTI、GD-LONG-TITLE；
2. `render_docx.py` 转为 PDF/逐页 PNG，检查每一页 100% 缩放，不抽查；
3. 保存按模板版本分目录的 canonical PNG golden，并用 skill 的 render/diff 或等价 Pillow 工具比较；先断言页数/尺寸一致，再使用经主 agent批准的小阈值视觉 diff，任何文字裁切、重叠、缺字、字体替换、异常空白页均硬失败；
4. 每次 token、`docx` 版本、字体或 LibreOffice 版本变化必须全量重渲染并独立人工批准，不允许盲目更新 golden。

Windows Word 门禁：在装有目标字体的 Windows 10 和 Windows 11 x64 各至少用桌面 Word 打开/导出一次三类黄金，逐页检查并记录 Word build、字体版本、页数和截图/PDF。LibreOffice golden 是自动回归，不替代 Word 目标应用验收；若没有可用 Word，只能把 Stage 7 标为“LibreOffice 已通过、Word 待验收”，不能宣称最终 DOCX 视觉交付完成。

视觉检查必须覆盖：A4 尺寸、长标题自然换行且不裁切、标题与首段不分离、中文 glyph、两端对齐、2 字符缩进、1.5 倍行距、段前后 0、多页连续性、孤行控制、落款/日期同页右对齐、无页眉页脚/空白页/隐藏内部文本。

## 测试矩阵

### documents 单元和结构测试

- GD-SINGLE：精确结构、单页预期、标题/正文/落款/日期文本；
- GD-MULTI：多页流动、无硬分页、末页落款；
- GD-LONG-TITLE：长标题换行、`keepNext` 和文件名 90 code-point 截断；
- synthetic other：任意合法发布主体右对齐，证明不硬编码学院名；
- 标题形式：纯文本、`#`、`标题：`、整行 bold；
- 日期：闰日、非法日期、缺日期、当前日期不得兜底；
- 缺标题/正文/落款、问题清单、内部说明、fence、placeholder 全部拒绝；
- Windows 非法字符、保留名、emoji、组合字符、空清理结果和 255 component 边界；
- OOXML token、metadata、关系 allowlist 和内部数据负向扫描。

### main/IPC/项目集成

- 任意线性/分支历史版本导出，latest 不移动、版本/批注不变，只新增一条 export record；
- 归档项目导出；无版本、伪造 versionId、错误 owner、child frame、坏 origin、未知字段拒绝；
- dialog 取消零副作用；dialog 期间 revision 变化在写入前冲突；重复点击按 gate 串行；
- 新文件、用户确认覆盖、目标被占用、只读目录、目录消失、磁盘满、中文长路径和总路径超过 260 字符；
- worker crash/空/超大 bytes、write/sync/rename/readback 故障，均无 succeeded record 且旧目标完整；
- post-HEAD 响应丢失对账为成功；文件成功但 commit 前失败报告部分成功且不删除文件；
- 项目中注入 synthetic Prompt/comment/retrieval/task/supplement/key sentinel，导出后解包扫描证明只有版本正文进入 DOCX；
- preload key snapshot只增加命名 documents API，无 Buffer/path/fs/general invoke；
- renderer 对当前和历史选定版本显示正确动作、取消/失败/成功状态，窄窗口无重叠。

### 生产 asar 和便携目录

- production `electron.vite` 增加独立 `document-worker.js` entry，`@news-writer/documents` 和 `docx` 打进 asar；worker URL 在 packaged asar 中可启动；
- `electron-builder.yml` 仍只带批准的 `out/**`、package metadata 和 notices；无 Python、LibreOffice、skill、测试 golden、源 DOCX/PDF/PNG、模板原始文件或原项目材料；
- `package:dir` 重跑许可证、asar allowlist 和文本/绝对路径/secret scanner；
- package smoke 在 `release/win-unpacked` 真实导出一个合成中文长路径 DOCX、解包结构检查，并用外部 QA renderer 检查 PNG；用户机器无需 Node、Python、conda 或浏览器。

## 编码准入和退出条件

批准 coding agent 在 `packages/documents`、必要的 shared/domain DTO/错误枚举、main/preload/renderer、electron-vite/package scripts 和对应 tests/golden 范围内实现。建议先完成 parser/template 纯函数和结构测试，再接 worker/main 原子导出与记录，最后接 IPC/UI/打包/渲染。不得修改 `<legacy-news-root>`，不得迁移 Python、引入 sidecar、手写 OOXML fallback、实现图片/压缩包/Word 批注/修订或扩大到旧 outputs 兼容。

完成后必须由不同 agent 独立 post-review，检查模板 token、实际渲染、外部写入与记录竞争、内部数据排除、renderer 安全边界、licenses 和 packaged asar。全量 `format/lint/typecheck/unit/component/Electron E2E/build/package:dir/package smoke` 通过，LibreOffice 每页 PNG 与 Word 实机验收均记录后，Stage 7 才能关闭。

## 冲突和最终结论

纯 TypeScript 产品与开发期 Python/LibreOffice QA 不冲突，前者进入产品，后者只在构建/验收机运行。A4 named override 与 skill 的默认 Letter 不冲突；它是针对中文新闻送审场景的明确覆盖，也修正了原脚本无意继承 Letter 默认的问题。任意版本导出、批注永久跟随版本和 DOCX 忽略批注彼此一致。

当前没有阻止编码的内部架构冲突。唯一尚未完全由代码闭合的是专有目标字体在所有 Windows 机器上的可用性/授权；必须按本文把它作为发布视觉验收前提，而不能把字体替换隐藏为成功。除此之外，本文边界足以进入 Stage 7 小范围编码。
