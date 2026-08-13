# 安全与隐私说明

## 不要提交的内容

- API Key、Bearer token、密码、`auth.json` 或任何凭据
- 用户项目目录、活动纪要、实际生成稿件、导出 DOCX 和诊断日志
- 原始 DOC/DOCX/PDF/PPTX/图片资料
- `review/knowledge/candidates-pending`、来源清单和本机审核中间件
- `node_modules`、`release`、测试渲染输出、字体安装包和开发机缓存

`.gitignore` 已覆盖常见目录和凭据文件，但提交前仍必须扫描暂存区。

## 认证边界

Renderer 不能访问 Node.js、文件系统或凭据，只能通过 preload 调用 schema 校验后的 IPC。DeepSeek API Key 由主进程保存到当前用户目录的安全存储，项目复制到其他电脑后不会携带认证信息。

## 知识库边界

`resources/institution` 仅包含合成占位配置和四个合成知识库文件；公开仓库不包含内部新闻稿、原始 Office、图片或字体。正式内部 profile 必须从私有输入替换占位 bundle，不能把内部语料随公开源码发布。应用只加载随包的唯一 profile，不读取 staging 或原项目。

## 报告问题

不要在 Issue、Pull Request 或聊天记录中粘贴 API Key、项目文件、Prompt、个人信息或完整诊断日志。请先脱敏，并仅提供诊断编号、版本号、操作步骤和最小复现信息。
