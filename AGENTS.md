# Agent 工作约束

本文件适用于 `news_writer` 目录下的所有 agent 工作。`GOAL.md` 是产品目标，`IMPLEMENTATION_PLAN.md` 是实施顺序。

## 不可违反的边界

- `<legacy-news-root>` 只读。不得编辑、格式化、移动、删除或生成文件到该目录。
- 所有写入必须位于 `<repo-root>`。
- 产品实现必须是 Electron + React + TypeScript + Monaco Editor。
- 不迁移、复用或运行原项目 Python/PowerShell 作为产品实现，不使用 Python sidecar。
- renderer 不得直接访问 Node.js、文件系统、凭据或不受控 IPC。
- API Key 不得进入项目、Prompt、日志、测试 fixture、导出文件或提交内容。
- 失败、取消、超时和空 AI 结果不得创建成功版本或覆盖现有版本。
- 不得实现首版范围外的知识库管理、旧项目导入、自动更新、安装包或多供应商公开配置。

## 模块职责

- `packages/domain`：不依赖 Electron、React、文件系统和网络的纯业务规则。
- `packages/project`：项目 Schema、持久化、迁移、原子保存和恢复。
- `packages/ai`：DeepSeek/OpenAI-compatible 内部客户端和任务协议。
- `packages/retrieval`：规范化、分词、BM25 和检索报告。
- `packages/documents`：DOCX 生成、样板和验证辅助。
- `packages/shared`：跨进程 Schema、类型、错误模型和不可变协议。
- `apps/desktop/main`：受信任的桌面能力和安全边界。
- `apps/desktop/preload`：最小、显式、可校验的 renderer 桥接接口。
- `apps/desktop/renderer`：React/Monaco UI，不包含特权逻辑。

## 强制工作流

任何新模块或新框架进入编码前：

1. 独立审查 agent 记录必要性、可复用能力和成熟开源候选。
2. 主 agent 明确批准模块边界和验收条件。
3. coding agent 实现模块和测试，不扩大范围。
4. 独立 review agent 检查行为、安全、测试和重复实现。
5. 主 agent 才能合并为下一阶段依赖。

主 agent 负责统筹、架构、集成、验收和汇报。具体模块代码交给 coding agent。

## 通用工程规则

- 文本文件默认 UTF-8；PowerShell 读取中文时显式使用 `-Encoding UTF8`。
- 不把终端乱码直接判断为文件损坏，应以显式编码读取结果为准。
- Windows 路径使用结构化路径 API，不手工拼接分隔符。
- 项目写入使用追加数据或临时文件加原子替换，并保留崩溃恢复策略。
- 所有外部输入，包括项目文件、IPC、AI 响应和配置，都必须运行时校验。
- 优先纯 JavaScript/WASM 依赖。引入原生 Node 扩展必须说明 ABI、打包和替代方案。
- 领域层必须可在不启动 Electron 的情况下测试。
- GUI 必须验证正常、加载、空状态、错误、取消和较小窗口布局。
- DOCX 必须实际渲染检查，不能只测试 ZIP 结构或“可以打开”。
- 保持提交和修改范围聚焦；不得顺手修改无关文件。

## 版本和批注关键规则

- 成功版本不可变，版本关系由 `parentVersionId` 表示。
- `latestVersionId` 是显式状态，不等同于创建时间最新。
- 切换最新版不会删除或覆盖任何分支。
- 批注永久属于对应 `versionId`。
- 只有当前最新版的批注可新增或编辑；历史版本被设为最新版后，其原批注恢复可编辑。
- 从某版本生成时，将该版本届时的全部批注快照进实际发送 Prompt。
- 新版本不继承父版本批注；DOCX 导出忽略所有批注。
