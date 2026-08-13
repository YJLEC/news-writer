# 机构配置包架构决策

## 决策

每个机构构建一个专属 App。App 只加载一个随包携带的只读 profile，不提供普通用户切换、导入、编辑、删除或重建配置/知识库的入口。

配置包位于 `resources/institution`，由一个严格校验的 manifest 绑定机构信息、写作规则、Prompt contract、DOCX 样式、只读知识库和可选字体资源。公开仓库只包含 synthetic/public fixture；正式机构资源从仓库外的 staging 目录注入。

## 边界

`packages/institution` 负责纯数据 Schema、bundle 构建和加载。它复用 retrieval 的知识库 validator，不读取项目目录、不连接网络、不解析原项目 Python 代码。主进程负责从 app resources 解析路径并缓存不可变 snapshot；domain 只接收 snapshot，不能自行访问文件系统。Renderer 只接收经过 IPC Schema 校验的 profile view。

系统安全边界由代码固定保留：纪要和用户确认信息是事实来源，历史稿只作结构/标题/文风参考，不凭空编造，不泄露凭据/路径/内部任务信息，导出 DOCX 不含 Prompt/批注/检索/任务数据。机构规则只能替换标题、结构、称谓、叙事、渠道文风、落款日期和字数建议，不能关闭这些约束。

## 资源结构

```text
resources/institution/
  manifest.json
  institution.json
  rules/
    writing-rules.json
    prompt-contract.json
    document-style.json
  knowledge/
    corpus.jsonl
    index.json
    training_rules.txt
    metadata.json
  fonts/
    manifest.json
```

字体文件只有在供应商许可明确允许随 App 再分发时才进入单独、经过复核的私有包。公开仓库及默认打包配置只携带 manifest；否则 manifest 只记录 family、文件名、版本、hash、许可证和目标系统安装要求。

## 失败策略

配置缺失、未知文件、hash/byteLength 不匹配、Schema 错误、知识库无效或字体 manifest 不一致都必须产生明确资源错误。App 不崩溃、不静默回退到另一个机构、不联网下载、不自动重建。profile 无效时允许错误界面启动，但阻止生成和修改操作。

## 许可证

仓库代码使用 MIT。真实机构规则、历史稿、知识库、字体和原项目材料不因代码许可证获得再分发授权，必须由机构和字体供应商分别授权。第三方依赖仍按各自许可证执行。
