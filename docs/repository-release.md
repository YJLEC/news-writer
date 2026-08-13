# 源码仓库发布说明

本文记录 News Writer 首个内部测试版源码进入 Git 管理前的边界。

## 保留内容

- TypeScript 源码、测试、架构文档、用户指南和构建配置
- `resources/institution` 下的合成占位 profile 及四个知识库文件
- 知识库接口、校验和检索测试（不包含候选原文和来源清单）

## 排除内容

- `node_modules`、`dist`、`apps/desktop/out*`、`release`
- `tests/artifacts`、`test-results`、Playwright 报告和 DOCX/PDF/PNG
- `resources/institution` 的内部正式 profile、字体和知识库、`review/knowledge` 全部审核材料、来源清单和审核中间件
- `公文字体安装包`
- API Key、`auth.json`、项目目录、日志和本机缓存

## GitHub 仓库性质

正式知识库的用户授权范围是内部 App 使用。因此公开仓库只保留合成占位 bundle；内部构建必须从私有位置注入正式知识库，不能仅依赖 `.gitignore` 事后补救。

## 首次发布检查

公开构建使用合成身份 `org.example.news-writer`；不得将真实机构域名、正式机构名称、生产知识库或授权字体写回公开配置。发布前应对暂存区执行机构标识、绝对路径、凭据和二进制资料扫描。

Git 提交元数据也可能公开作者姓名和邮箱。首次推送前请检查 `git log --format=fuller`；如不希望公开当前本地身份，应在新的公开仓库中创建干净的初始提交，或由仓库所有者在确认后重写历史。不要把包含私有审核材料的本地对象或分支推送到远程。

```powershell
git status --short
git add --all
git diff --cached --name-status
corepack pnpm public:check
git grep --cached -n -I -E "(credential-marker|absolute-path-marker|email@example\\.invalid)" -- README.md SECURITY.md CONTRIBUTING.md docs/user-guide.md resources/institution
git ls-files review
git ls-files "公文字体安装包"
corepack pnpm verify
corepack pnpm test:e2e
corepack pnpm test:package
corepack pnpm licenses:check
```

`git grep` 无输出且所有验证通过后，才允许创建本地首个提交。远程 URL、默认分支和推送操作由仓库所有者另行确认。
