# News Writer

News Writer 是一个面向 Windows 10/11 x64 的 Electron + React + TypeScript 新闻稿写作工作台。它把活动纪要、Prompt、AI 任务、新闻稿版本、批注、历史检索记录和 DOCX 导出记录保存在可迁移的项目目录中。

当前源码对应首个主体流程完整的测试版（`0.1.0`）。公开仓库包含可复现的合成机构 profile 和测试资源；正式机构资源应由管理员按文档单独构建和分发。

## 已实现功能

- 创建、打开、归档和复制项目
- 学院新闻稿与其他新闻稿两种项目类型
- 活动纪要的创建、导入、编辑和保存
- 只读内置知识库检索（BM25），自动把历史参考稿标题与节选加入初稿 Prompt
- Prompt 生成、编辑、风险提示和实际发送 Prompt 留存
- AI 初稿生成、缺失信息补充、可选 AI 二次审稿
- 当前版本批注、按照批注更新 Prompt、历史版本浏览和 Monaco diff
- 历史版本回溯为最新版，并从历史版本创建分支
- 只在用户明确操作时导出干净 DOCX
- DeepSeek 认证信息使用本机用户目录安全存储，不写入项目、Prompt、日志或导出文件

## 代码结构

```text
apps/desktop/main       Electron 主进程、项目服务、任务协调和安全 IPC
apps/desktop/preload    受控 preload API
apps/desktop/renderer    React + Monaco 工作区
packages/domain         版本、批注、任务、Prompt 和配置规则
packages/project        项目格式、原子保存和恢复
packages/ai             DeepSeek 客户端、worker、取消和错误模型
packages/retrieval      内置知识库 loader、分词、BM25 和检索报告
packages/documents      DOCX builder、样板和结构审计
packages/institution   只读机构配置包 Schema、哈希校验和资源加载
packages/shared         IPC schema、DTO、错误和脱敏规则
resources/institution  合成占位机构配置包及其只读知识库
tests                   单元、组件、Electron E2E 和 package smoke 测试
docs                    功能基线、架构审查、QA 和用户指南
```

## 开发环境

- Windows 10/11 x64
- Node.js `24.18.0`
- pnpm `11.20.0`（通过 Corepack）

安装依赖并验证：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

常用命令：

```powershell
corepack pnpm dev             # 开发模式
corepack pnpm test:e2e        # Electron E2E
corepack pnpm test:package    # 便携包 smoke
corepack pnpm package:dir     # 生成 release/win-unpacked
corepack pnpm licenses:check  # 许可证门禁
corepack pnpm public:check    # 公开仓库敏感材料和资源白名单门禁
```

管理员为机构构建 profile 时，应准备独立的 staging 目录和显式 `input.json`，使用 `corepack pnpm private:profile:build -- --staging <staging> --output <profile>` 生成经过校验的固定资源；完整输入约束和字段说明见 [docs/institution-profile-admin.md](docs/institution-profile-admin.md)。

完整使用和交付说明见 [docs/user-guide.md](docs/user-guide.md)。

## 数据与脱敏边界

- API Key 只保存在当前 Windows 用户的安全存储中，仓库和项目文件不包含认证信息。
- 用户项目稿件不会自动进入知识库。
- `resources/institution/knowledge` 是公开仓库随附的合成占位 bundle，只用于演示和测试检索链路，不包含正式机构历史稿。
- `resources/institution` 是公开仓库随附的 synthetic/public fixture。正式机构配置、字体和知识库由管理员构建专属 profile 后随专属 App 分发。
- 审核候选、来源清单、原始 Office 文件、字体安装包、QA 渲染产物和便携打包目录均不属于源码仓库。
- 提交前必须执行凭据扫描，并检查暂存区而不是只检查工作区。

公开发布前运行 `corepack pnpm public:check`。该检查会拒绝私有审核/字体/构建目录、凭据、联系方式、真实路径、Office/图片/字体等源材料，以及 `resources/institution` 白名单之外的资源。公开仓库只发布代码、文档、测试和合成 profile；机构专属 profile、审核材料和源文件应按管理员指南单独保管和分发。

## 当前交付边界

首版只正式支持 DeepSeek，不支持流式生成、知识库管理、多供应商公开配置、自动更新、安装包和正式代码签名。当前便携包使用 Electron 默认图标且未签名；签名和品牌资源将在后续分发阶段单独配置。

公开仓库中的 RAG 资源是合成占位数据。内部使用的正式知识库、审核候选和来源文件必须通过私有构建输入注入，不能提交到公开仓库。
