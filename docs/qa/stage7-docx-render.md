# Stage 7 DOCX 渲染验收记录

日期：2026-08-12

## 自动结构门禁

- 模板：`standard_business_brief.zh_news_a4.v1`
- 正式 TypeScript builder 样例：`GD-SINGLE`、`GD-MULTI`、`GD-LONG-TITLE`
- 自动检查：ZIP/OOXML、A4 页面、四个命名样式及精确 token、可见文本顺序、固定元数据、无 comments/custom properties/外链/修订/隐藏文本/内部 sentinel。
- 产品和便携目录不包含 Python、LibreOffice、PDF、PNG 或 QA 源 DOCX。

## 渲染环境和结果

- documents skill Python：`<bundled-python>`
- skill renderer：`<documents-skill-renderer>`
- Windows：Microsoft Windows 11 家庭版 中文版，版本 `10.0.26200`，x64。
- LibreOffice：`26.2.5.2`（`soffice.com --headless --version` 成功；文件版本 `26.2.5.2`）。
- 目标字体已安装并注册到当前用户字体目录 `<user-font-directory>`：
  - `仿宋_GB2312.ttf`，内部字体名 `FangSong_GB2312`，SHA-256 `FEF7CF991B458CABD184B73378918D9D15429010E1D6C804F08D394395C3C3B4`。
  - `方正小标宋简.TTF`，内部字体名 `FZXiaoBiaoSong-B05S`，SHA-256 `F6154B97EE71BAD19EFA7F78EDC152CF515C1F943220FC6E98360005D53D1C62`。
- 渲染输出：`<repo-root>\tests\artifacts\stage7\render\2026-08-11\checked7\`。该目录仅为 QA 中间产物，不进入产品或 `release/win-unpacked`。
- 本轮修复后重新生成并渲染输出：`<repo-root>\tests\artifacts\stage7\render\current\`；最终 builder 在兼容性清理后再次执行完整 `auditNewsDocx`。
- 页数和 100% 逐页视觉检查：
  - `GD-SINGLE`：1 页，A4；标题居中、正文两端对齐/首行缩进、落款日期右对齐同页，全部通过。
  - `GD-MULTI`：2 页，均为 A4；第 1 页的行尾悬挂标点通过 `w:overflowPunct w:val="1"` 保留为“分别登 / 记，避免”，跨页连续，无空白页或裁切，落款日期同页右对齐，全部通过。
  - `GD-LONG-TITLE`：1 页，A4；长标题自然分为三行且无截断，标题与首段未分离，落款日期同页右对齐，全部通过。
- 未发现字体缺字、重叠、裁切、异常分页、隐藏内部文本或批注/Prompt/检索信息；三份 PDF 与源 fixture 逐字符一致（222/222、812/812、242/242）。
- 未发现字体替换或字体缺失警告。LibreOffice 标准错误中出现一次 `Could not find platform independent libraries <prefix>` 环境提示，不影响 PDF/PNG 产出；初次 Windows profile URI 的 `libpng error: Write Error` 已通过 QA 临时 URI 适配解决，最终三份渲染均成功。
- `overflowPunct` 结构审计：仅正文段落出现（3/12/3），标题、落款和日期不出现；篡改为 `val="0"` 会被审计拒绝。
- 本轮导出回归：标题和落款不再写入 `w:keepNext`，避免 Word 开启格式标记时在段落左侧显示黑色方形；标题、正文、落款和日期的实际 PDF/PNG 渲染仍无裁切、重叠或异常分页。
- 本轮直接 LibreOffice 渲染输出：`<repo-root>\tests\artifacts\stage7\render-local\direct-render\`；`single-page` 为 1 页，`multi-page` 为 2 页，`long-title` 为 1 页。documents skill 的 `render_docx.py` 在本机 Windows profile URI 下出现 `libpng error: Write Error`，随后使用同一 LibreOffice 直接生成 PDF，并用 bundled Poppler `pdftoppm.exe` 生成逐页 PNG 完成视觉检查；该环境问题不影响 PDF/PNG 内容。

## 结论

结构、内容纯净、IPC、持久化、便携包和实际 DOCX 视觉门禁均通过。三份样例已使用目标字体经 LibreOffice 实际渲染，并完成全部页面的 100% 检查；Stage 7 的视觉验收项已关闭。

本轮应用修复回归：DOCX 导出按钮已移动到最新版编辑器栏并保留“当前选中版本”语义；导出成功响应已裁剪为 IPC 视图 DTO，避免文件已发布后因响应 schema 拒绝而误报失败。三份样例重新生成于 `tests/artifacts/stage7/render-local/`，渲染于 `tests/artifacts/stage7/render-local/direct-render/`，页数为 1、2、1，逐页检查结论不变。
