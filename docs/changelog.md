# 更新日志

## 1.0.0（2026-08-15，首个正式版本）

### 新增

- 项目级图片附件：渲染器 Canvas 压缩（EXIF 旋转 + 最长边 2048px + <1MB JPEG）与缩略图预览、上移/下移/删除/清空，硬上限 5 张（无图注）；DOCX 在正文与落款之间插图（宽=可用页宽、竖图按高度缩放），并扩展数据模型、项目存储、IPC 与 DOCX 审计白名单。
- 机构写作规则按 `scenarios` 过滤：`profileSnapshot.rules` 携带 `{text, scenarios}`，按 `official→college-news`、`other→other-news` 注入 Prompt。

### 修复

- 修复 Windows 检出时 CRLF 行尾破坏所有按字节哈希校验的资源（机构 profile、测试 fixtures/golden）：新增 `.gitattributes` 强制 LF。
- 修复私有 profile 的机构身份字段（`officialPublisher` / `targetChannels` / `defaultWordCountRecommendation`）未接入生成链路，导致 Prompt 仍显示硬编码的「示例学院 / 学院网站」。
- 修复机构 profile 加载失败被静默吞掉、应用以无 profile 状态运行的问题：现在会记录诊断事件、弹出错误提示，并新增 `PROFILE_RESOURCE_INVALID` 错误码。
- 修复私有便携包打包后校验路径缺少 `win-unpacked` 段（`scripts/package-private-profile.mjs`）。
- 修复脱敏规则：手机号/座机漏报、学号误报任意 10–12 位数字、apiKey 规则先于邮箱执行导致邮箱被遮蔽。
- 修复缺失日期时 DOCX 解析静默删除正文/落款。
- 修复 IPC DTO 与领域层校验不一致：配置覆盖接受显式 `undefined`、批注视图缺 `quotedText === anchor.exact` 校验、导出记录文件名缺路径分隔符校验。
- 修复 DOCX 导出文件名不防 Windows 保留名（`CON`/`NUL` 等）；放宽标题识别（允许年份开头和长标题）。
- 修复导入纪要时错误码不当、非法 UTF-8 被静默替换。
- 修复领域层与项目层事务 UUID schema 不一致（大小写/版本）。
- 修复 AI 协调器 phase 可被迟到的状态迁移回退；非 AI 内部错误不再误报为可重试的网络错误。
- 修复标题段落误用正文 1.5 倍行距：新增 `titleLineSpacing`，标题改用 `document-style.json` 的 `title.lineSpacing`（单倍行距）。

### 变更

- AI 生成、二次审稿、续改期间禁止其他写操作（纪要、批注、配置、导出、版本切换），并移除冗余的 `targetRevision` 校验。
- 删除「补充信息」功能：AI 二次审稿现在单次完成，不再暂停等待用户填写补充事实。
- 活动纪要增加防抖自动保存（停止输入约 1 秒后自动保存）。
- Prompt 移除对撰写无意义的机构元数据（`profileId`、各类版本号），机构写作规则由「仅作补充指导」改为「必须遵守」。
- Prompt 场景设置：其他新闻稿的目标渠道不再套用学院渠道，默认使用「目标平台」。
- Prompt 明确区分「落款主体」（固定为学院官方发布主体）与「活动主办方」；事实检查中的「举办/组织主体」改为「活动主办/组织方」，防止外部单位主办时把落款误写成主办方。
- DOCX 页边距单位支持厘米（如 `2.54cm` / `3.18cm`），落款与日期段落改为对齐文档网格（`snapToGrid=1`），对齐 BUPT-QMUL 宣传部送审排版标准。
