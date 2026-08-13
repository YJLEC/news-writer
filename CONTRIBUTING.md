# 协作约定

## 开始修改前

1. 阅读 `AGENTS.md`、`GOAL.md` 和 `IMPLEMENTATION_PLAN.md`。
2. 明确改动属于哪个 package 或 Electron 边界。
3. 新模块或明显扩展在进入编码前由独立 review agent 检查必要性、可复用性和成熟开源方案。
4. 不修改或运行时依赖 `<legacy-news-root>`。

## 修改与验证

- 领域规则保持在 `packages/domain`，不要把业务规则放进 renderer。
- IPC 输入输出必须使用现有 shared schema 和 DTO，不直接跨边界传领域对象。
- 耗时 AI、DOCX 和检索工作不得阻塞 renderer 或主进程。
- 新行为要增加对应的单元、组件或 Electron E2E 测试。
- DOCX 改动必须实际渲染并进行视觉检查。
- 提交前运行：

```powershell
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:e2e
corepack pnpm test:package
corepack pnpm licenses:check
```

## 提交内容

提交应保持单一主题，说明行为变化、测试命令和已知限制。不要提交构建产物、运行时项目、凭据、原始新闻资料或本机绝对路径。
