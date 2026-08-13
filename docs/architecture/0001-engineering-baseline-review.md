# 0001 工程基线独立审查

- 状态：批准进入最小骨架阶段
- 审查日期：2026-08-09
- 审查范围：阶段 0 的工程选型、依赖准入和模块边界
- 约束来源：`AGENTS.md`、`GOAL.md`、`IMPLEMENTATION_PLAN.md`

## 结论

建议采用 `pnpm workspace + electron-vite + Vite + React + TypeScript` 的最小 monorepo，使用 Vitest 完成包级测试、Playwright 驱动真实 Electron 完成端到端测试，并以 `electron-builder --dir` 生成 Windows x64 的完整便携目录。

该组合满足纯 TypeScript、Electron 三进程分层、本地 Monaco、无 Python sidecar、无运行时原生 Node 扩展和无额外浏览器安装等约束。coding agent 可以开始搭建最小工程骨架，但只能建立编译、类型检查、测试、lint、格式检查、空窗口、安全 preload 边界和目录打包入口，不得提前实现业务 Schema、完整 GUI、知识库、真实 AI 或 DOCX。

## 必要性与复用判断

| 能力 | 结论 | 理由 |
| --- | --- | --- |
| pnpm workspace | 必要 | 原定结构包含多个 app/package；pnpm 自带 workspace、严格依赖边界、锁文件和许可证清单，不需要额外 monorepo 框架。 |
| Nx/Turborepo | 暂不引入 | 首版只有一个桌面 app，TypeScript 项目引用和 pnpm 脚本足以编排；新增任务图和缓存层目前没有回报。 |
| electron-vite | 采用 | 复用成熟的 main/preload/renderer 三目标开发和打包构建能力，减少手写多份 Vite/Rollup 配置。 |
| Electron Forge | 不采用 | 更适合由 maker 生成安装产物；首版只验收便携目录，且其 Vite 路径不会减少当前三目标构建复杂度。 |
| React | 必要 | 已由目标指定，用于工作台 UI。首批不引入状态管理库或路由库，待对应模块审查后再决定。 |
| Monaco Editor | 必要 | 已由目标指定。直接使用本地 `monaco-editor` ESM 和 Vite worker，不使用 CDN，也不先引入 React 包装器或 Monaco 专用 Vite 插件。 |
| Zod | 采用 | 同一套运行时 Schema 可校验磁盘、IPC、配置和 AI 边界，同时推导 TypeScript 类型；避免手写并行校验器。 |
| Vitest | 采用 | 与 Vite/TypeScript 集成成熟，可覆盖 domain、project、AI、retrieval、documents 和 renderer 组件。 |
| Playwright | 采用 | 能启动 Electron 并验证真实 Chromium、IPC、安全边界、Monaco、窗口尺寸和截图；Monaco 不应依赖 DOM 模拟器完成验收。 |
| electron-builder | 采用 | `--dir --win --x64` 可输出 `win-unpacked` 完整目录，并能明确控制 `asar`、文件白名单和 `extraResources`。不使用 portable 单文件 target。 |
| 独立打包/测试编排器 | 暂不引入 | 根脚本加 pnpm 递归命令足够；后续出现可测的性能或编排问题再审查。 |

## 推荐版本基线

以下版本来自 2026-08-09 的 npm registry 快照。首个骨架应使用精确版本，不写 `^` 或 `~`，并提交唯一的 `pnpm-lock.yaml`。

| 组件 | 精确版本 | 许可证 | 说明 |
| --- | ---: | --- | --- |
| 开发 Node.js | 24.18.0 | MIT | 锁定开发/CI 主版本和补丁；满足全部工具的 Node 要求，不等同于 Electron 内置 Node。 |
| pnpm | 11.20.0 | MIT | 在根 `packageManager` 字段精确锁定，通过 Corepack 使用。 |
| Electron | 43.3.0 | MIT | Windows x64 运行时；升级 Electron 必须单独跑安全和端到端回归。 |
| React / React DOM | 19.2.8 | MIT | 两者保持完全相同版本。 |
| TypeScript | 6.0.3 | Apache-2.0 | 与 `typescript-eslint` 的 `<6.1.0` peer 范围兼容。 |
| monaco-editor | 0.56.0 | MIT | 仅本地资源；显式配置编辑器 worker。 |
| electron-vite | 5.0.0 | MIT | peer 支持 Vite 5/6/7，`@swc/core` 是可选项且不安装。 |
| Vite | 7.3.6 | MIT | 不采用 Vite 8；electron-vite 5 的 peer 范围尚不包含 Vite 8。 |
| @vitejs/plugin-react | 5.2.0 | MIT | peer 同时覆盖 Vite 7；不用带原生 SWC 的 React 插件。 |
| Zod | 4.4.3 | MIT | 根 overrides 保证运行时只有一个版本。 |
| Vitest / coverage-v8 | 4.1.10 | MIT | 两者版本保持一致。 |
| @playwright/test | 1.62.1 | Apache-2.0 | Electron 测试使用 Electron 自带 Chromium，不以独立浏览器为产品依赖。 |
| Testing Library React | 16.3.2 | MIT | renderer 组件行为测试。 |
| Testing Library user-event | 14.6.3 | MIT | 模拟用户输入。 |
| happy-dom | 20.11.2 | MIT | 仅测试轻量 React 组件；Monaco 和 Electron 安全边界用真实 Electron 测试。 |
| ESLint | 10.8.1 | MIT | 使用 flat config。 |
| typescript-eslint | 8.66.0 | BSD-2-Clause | 支持 ESLint 10，但要求 TypeScript `<6.1.0`。 |
| eslint-plugin-react-hooks | 7.1.1 | MIT | React Hooks 规则。 |
| eslint-plugin-react-refresh | 0.5.3 | MIT | renderer 开发规则。 |
| Prettier | 3.9.6 | MIT | 只负责格式，不和 ESLint 重复承担样式规则。 |
| electron-builder | 26.15.3 | MIT | 只启用 Windows x64 directory 输出。 |

首批还应把 `@types/node` 固定为 24.13.3、`@types/react` 固定为 19.2.18、`@types/react-dom` 固定为 19.2.4。类型包补丁可以随维护批次升级，但必须经完整 typecheck。

### 版本策略

1. `package.json` 中所有直接依赖和开发依赖均使用精确版本，禁止范围版本。
2. 只允许根目录存在一个 `pnpm-lock.yaml`；CI 和验收使用 `pnpm install --frozen-lockfile`。
3. Node 用仓库版本文件与 `engines` 同时约束为 24.18.0；Electron 内置 Node/Chromium 版本从运行时读取并写入诊断信息，不由 `@types/node` 代替。
4. 每次 Electron 大版本升级作为独立维护变更，必须验证 Windows 10/11、`safeStorage`、utility process/worker、preload、Monaco worker 和打包目录。
5. 普通依赖按受控批次升级，先更新锁文件，再运行 lint、format check、typecheck、unit、integration、Electron E2E 和许可证检查。
6. 当前不能组合 Vite 8 与 electron-vite 5，也不能组合 TypeScript 7 与 typescript-eslint 8。这两个约束应进入依赖检查说明，等待上游 peer 范围明确支持后再评估。

## Monorepo 与构建边界

根目录只负责工作区、统一工具版本和聚合脚本，不承载业务代码。使用 pnpm workspace 和 TypeScript 项目引用，不使用路径穿透导入；包之间只能通过各自 `exports` 暴露公开入口。

建议依赖方向：

```text
domain                     (无 workspace 依赖，无 Electron/React/fs/network)
shared                     (跨进程 DTO、IPC Schema、错误协议)
project  -> domain, shared (持久化 Schema、迁移、原子写入)
ai       -> domain, shared (客户端边界与任务协议)
retrieval-> domain/shared  (仅在确有共享类型时依赖)
documents-> domain/shared  (只接收导出 DTO，不读取 UI 状态)

desktop/main    -> project, ai, retrieval, documents, shared, domain
desktop/preload -> shared
desktop/renderer-> shared；业务展示需要时可依赖 domain 的只读纯类型/纯函数
```

`shared` 不能成为通用工具垃圾箱。持久化 Schema 属于 `project`；跨进程请求/响应 Schema 属于 `shared`。`preload` 只暴露按用例命名的窄接口，不能暴露 `ipcRenderer`、任意 channel、任意路径文件 API 或凭据内容。

electron-vite 负责三个构建目标：

- main：Node/Electron 主进程目标，只在此组合受信任能力。
- preload：独立入口，输出最小 context bridge。
- renderer：Chromium 目标，只包含 React、Monaco 和非特权 DTO/逻辑。

Monaco 通过本地 ESM 引入，显式实现 `MonacoEnvironment.getWorker`，由 Vite 将 editor worker 拆成静态资源。生产环境不得访问 CDN，不允许为 Monaco 放宽为 `unsafe-eval`；CSP 至少限制 `default-src 'self'`，worker 只允许应用自身资源及确有必要的 `blob:`。

## 测试基线

| 层级 | 工具 | 首要覆盖 |
| --- | --- | --- |
| 纯单元测试 | Vitest，Node environment | domain 状态转换、配置覆盖、检索算法、错误映射。 |
| 文件集成测试 | Vitest，真实临时目录 | project 原子保存、迁移、恢复、Windows 路径；禁止 mock 掉关键文件语义。 |
| renderer 组件测试 | Vitest + Testing Library + happy-dom | 菜单、表单、状态、错误和无障碍语义；Monaco 用窄适配器替身。 |
| Electron E2E | Playwright | BrowserWindow 安全设置、preload 白名单、IPC Schema、真实 Monaco、diff、较小窗口、截图。 |
| 打包冒烟 | 打包后的 `win-unpacked` | 从产物启动、资源路径、无开发服务器、无独立浏览器依赖。 |

覆盖率用于发现盲点，不设一个可被无意义测试刷高的全局百分比作为唯一门禁。关键领域规则、Schema 拒绝路径、安全 IPC 和失败不产出版本必须逐条有正反测试。

## Lint、格式与边界执行

- ESLint 使用 flat config 和 type-aware TypeScript 规则；renderer 增加 Hooks/Refresh 规则。
- 用 `no-restricted-imports` 固化 renderer/preload 的禁止依赖，防止导入 `node:*`、Electron 特权 API 和其他包内部路径。
- TypeScript 开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`useUnknownInCatchVariables` 和 `noImplicitOverride`。
- Prettier 只处理格式；CI 分开运行 `lint`、`format:check`、`typecheck` 和 `test`，便于定位失败。
- 首批不引入 Husky/lint-staged。开发机 hook 不是可信门禁，必要检查应由统一脚本和 CI 执行。

## 打包和运行时资源

- 使用 electron-builder 的 directory 模式：`--win --x64 --dir`，验收对象是 `win-unpacked` 完整目录，不是安装包或单文件 portable exe。
- 使用严格 `files` 白名单和 `asar: true`；只读知识库通过 `extraResources` 放到明确目录，运行时只从 `process.resourcesPath` 解析。
- source map 默认不进入交付目录；调试符号作为单独内部产物时再审查。
- 包内写入一份构建元数据，记录 app、Electron、Chromium、Node、项目 Schema 和知识库版本。Chromium/Node 值应从实际 Electron 运行时或构建产物验证，不手填猜测。
- 打包检查必须证明不含 `.env`、API Key、测试 fixture、原始 Office/PDF/图片、Python、开发机绝对路径和开发依赖。

## 许可证与供应链准入

基线直接依赖均为 MIT、Apache-2.0 或 BSD-2-Clause。pnpm 自带许可证枚举能力，优先使用 `pnpm licenses list --prod --json`，不为此再引入许可证扫描包。

依赖准入规则：

1. MIT、Apache-2.0、BSD-2/3-Clause、ISC、0BSD 可在保留版权和许可证文本后使用。
2. MPL、CDDL、EPL、LGPL 或双许可证依赖必须逐项审查其链接、修改和分发义务。
3. GPL、AGPL、SSPL、BUSL、Elastic License、Commons Clause、非商业或来源不明依赖默认拒绝，除非用户明确批准并完成法律审查。
4. 每次锁文件变化都检查生产依赖许可证；发行目录保留 Electron 自带的 Chromium notices，并生成应用生产依赖的 `THIRD-PARTY-NOTICES`。
5. npm 元数据不是最终法律证明；发布前应抽查包内 LICENSE 文件、资源字体和未来知识库内容的授权来源。

## 原生扩展和二进制风险

首版运行时不批准任何原生 Node 扩展。SQLite、keytar、原生分词器、原生 diff、`@vitejs/plugin-react-swc` 等都不得由 coding agent 自行加入。

- 凭据使用 Electron 内置 `safeStorage`，不引入 keytar。
- 持久化先使用版本化文件格式与原子替换，不引入原生 SQLite。
- 中文分词优先纯 JS/WASM，需到 retrieval 模块审查时再决定。
- Vite/electron-vite/electron-builder 会在开发或打包阶段使用 esbuild、app-builder 等平台二进制；它们不是随应用加载的 Node ABI 扩展，但锁文件和构建主机仍需固定并做供应链检查。
- 任何原生扩展例外必须记录必要性、预构建二进制来源、Electron ABI、Windows x64 支持、重编译步骤、离线打包、许可证、替代方案和回退计划，经独立审查后才能进入锁文件。

## 已知风险与缓解

1. Electron 支持窗口短。精确版本保证可复现，但不能长期停留；发布前应升级到当时仍受支持的稳定版，并跑完整回归。
2. `electron-vite` 与 Vite 主版本存在 peer 滞后。当前固定 Vite 7，不能由自动更新工具跨到 Vite 8。
3. TypeScript 7 已发布，但当前 lint 工具 peer 不支持。固定 TypeScript 6.0.3，不为追新关闭 peer 校验或 lint 类型检查。
4. Monaco worker、CSP 和 asar/resource 路径在开发与打包环境不同。最小骨架就必须有打包后启动和 worker 加载冒烟测试。
5. Electron E2E 不能完全证明 renderer 不可越权。除端到端测试外，还要静态禁止特权导入，并对 BrowserWindow 配置、导航和每个 IPC handler 做单元/集成检查。
6. 未签名 Windows 程序可能触发 SmartScreen。首版记录风险但不把签名纳入骨架或交付实现。

## coding agent 准入范围

本审查批准 coding agent 开始最小骨架，边界如下：

允许：

- 创建上述 workspace/app/package 目录和最小 manifest、TypeScript 配置、electron-vite 配置。
- 建立精确依赖、锁文件和统一 `dev/build/typecheck/lint/format:check/test/package:dir` 入口。
- 创建只有静态占位内容的安全 BrowserWindow、最小 preload bridge 和 renderer。
- 建立一个纯函数单测、一个 React 组件测试、一个 Electron 启动/安全配置冒烟测试。
- 验证 `win-unpacked` 可脱离开发服务器启动，并记录实际 Electron/Chromium/Node 版本。

禁止：

- 实现项目 Schema、领域业务、知识库、检索、DeepSeek、凭据存储、DOCX 或完整工作台 UI。
- 引入原生 Node 扩展、状态库、路由库、UI 组件库或通用 IPC/文件 API。
- 修改或生成任何文件到 `<legacy-news-root>`。

骨架验收必须同时满足：冻结安装成功；lint、格式检查、typecheck、单元/组件测试通过；renderer 的 `nodeIntegration` 为 false、`contextIsolation` 为 true；preload 不暴露通用 IPC；打包目录可启动；生产产物不含开发服务器 URL、测试 fixture、凭据或 `news` 原始资料。达到这些条件后再交独立 review agent 审查，未通过审查前不能作为阶段 1 或阶段 2 的依赖。
