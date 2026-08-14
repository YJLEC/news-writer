# 更新日志

## 0.1.x（当前工作树，尚未发布）

### 修复

- 修复 Windows 检出时 CRLF 行尾破坏所有按字节哈希校验的资源（机构 profile、测试 fixtures/golden）：新增 `.gitattributes` 强制 LF。
- 修复私有 profile 的机构身份字段（`officialPublisher` / `targetChannels` / `defaultWordCountRecommendation`）未接入生成链路，导致 Prompt 仍显示硬编码的「示例学院 / 学院网站」。
- 修复机构 profile 加载失败被静默吞掉、应用以无 profile 状态运行的问题：现在会记录诊断事件、弹出错误提示，并新增 `PROFILE_RESOURCE_INVALID` 错误码。
- 修复私有便携包打包后校验路径缺少 `win-unpacked` 段（`scripts/package-private-profile.mjs`）。
- 修复脱敏规则：手机号/座机漏报、学号误报任意 10–12 位数字、apiKey 规则先于邮箱执行导致邮箱被遮蔽。
- 修复缺失日期时 DOCX 解析静默删除正文/落款。

### 变更

- AI 生成、二次审稿、续改期间禁止其他写操作（纪要、批注、配置、导出、版本切换），并移除冗余的 `targetRevision` 校验。
- 删除「补充信息」功能：AI 二次审稿现在单次完成，不再暂停等待用户填写补充事实。
- 活动纪要增加防抖自动保存（停止输入约 1 秒后自动保存）。
- Prompt 移除对撰写无意义的机构元数据（`profileId`、各类版本号），机构写作规则由「仅作补充指导」改为「必须遵守」。
- Prompt 场景设置：其他新闻稿的目标渠道不再套用学院渠道，默认使用「目标平台」。
- Prompt 明确区分「落款主体」（固定为学院官方发布主体）与「活动主办方」；事实检查中的「举办/组织主体」改为「活动主办/组织方」，防止外部单位主办时把落款误写成主办方。
