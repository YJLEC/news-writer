# 0002 最小工程骨架独立复审

- 状态：批准作为后续阶段依赖
- 初审日期：2026-08-09
- 复审日期：2026-08-09
- 审查角色：独立 skeleton review agent
- 审查基准：`AGENTS.md`、`0001-engineering-baseline-review.md`
- 审查范围：最小工程骨架、测试和 Windows x64 directory 打包；不审查业务功能

## 复审结论

初审提出的 3 项 P1、4 项 P2 和 1 项 P3 均已修正并重新验证。本轮未发现新的阻断性问题，最小骨架可以作为后续领域层和桌面能力实现的工程基础。

批准仅覆盖当前最小骨架，不代表预先批准后续业务模块、依赖或 IPC 能力。后续仍须遵守 `AGENTS.md`：每个新模块编码前先由独立 agent 审查必要性、可复用能力和成熟开源候选，coding agent 实现后再独立复审。

## Findings 复核

### [已解决 P1] 打包应用信任外部开发 URL

`apps/desktop/main/index.ts` 现在仅在 `import.meta.env.DEV && !app.isPackaged` 时读取 `ELECTRON_RENDERER_URL`，并将地址限制为无凭据的 `http:` localhost、`127.0.0.1` 或 `[::1]`。打包态始终使用应用自身的 `file:` 页面。

独立重放初审攻击：

```text
ELECTRON_RENDERER_URL=data:text/html,<h1 id="probe">Injected renderer</h1>

actual URL   file:///<repo-root>/release/win-unpacked/resources/app.asar/apps/desktop/out/renderer/index.html
#probe       0
heading      News Writer
```

攻击页面没有加载，preload bridge 只出现在可信应用页面。package smoke 已把该场景固化为回归测试。

### [已解决 P1] Electron fuse 没有安全交付基线

`electron-builder.yml` 已显式配置 Electron 43 的全部 8 个 Fuse V1 项；package smoke 从实际 EXE 读取 wire 并逐项断言。独立读取结果如下：

| Fuse V1 | 实际值 | 结论 |
| --- | --- | --- |
| `RunAsNode` | disabled | 阻止 `ELECTRON_RUN_AS_NODE` |
| `EnableCookieEncryption` | enabled | 使用操作系统能力保护 cookie |
| `EnableNodeOptionsEnvironmentVariable` | disabled | 阻止 `NODE_OPTIONS` 和额外 CA 环境注入 |
| `EnableNodeCliInspectArguments` | disabled | 禁用 Node CLI inspect 参数 |
| `EnableEmbeddedAsarIntegrityValidation` | enabled | 启用 Windows asar 完整性校验 |
| `OnlyLoadAppFromAsar` | enabled | 只从 `app.asar` 加载应用 |
| `LoadBrowserProcessSpecificV8Snapshot` | disabled | 与当前 Electron 43 Windows 产物一致 |
| `GrantFileProtocolExtraPrivileges` | enabled | 当前 `file:` + app.asar 启动路径所需，见下方说明 |

两个非直观值已经实测：

- 当前 Electron 43 Windows 目录没有 `browser_v8_context_snapshot.bin`，只有 `snapshot_blob.bin` 和 `v8_context_snapshot.bin`，因此 browser 专用 snapshot fuse 保持关闭。
- 在同目录复制 EXE、仅把 `GrantFileProtocolExtraPrivileges` 临时翻为关闭后，顶层 `file:///.../app.asar/.../index.html` 加载直接报 `ERR_FILE_NOT_FOUND`。因此当前保留为开启不是盲目沿用默认值，而是现有启动方式的运行要求。

`GrantFileProtocolExtraPrivileges` 仍是已知的临时安全折中。后续若改为受控自定义协议，应再次尝试关闭；在扩大 preload/IPC 能力或允许不可信内容进入 renderer 前，也必须重新评估该项。

### [已解决 P1] Monaco worker 未在真实 Electron 中被验证

renderer 的诊断组件现在创建真实 Monaco model、editor 和 web worker，并等待 `withSyncedResources` 成功后才将状态设为 `ready`。源态 E2E 和 package smoke 均断言：

- `data-monaco-status="ready"`；
- 页面至少存在一个 worker；
- 没有 `pageerror` 或 error console；
- package smoke 在 `file:`、asar、CSP 和 sandbox 的真实组合下执行。

这已证明 worker 不只是被构建，而是能在源态构建和便携目录中实际启动。

### [已解决 P2] 许可证命令不执行准入且发行目录没有应用 notices

`scripts/check-licenses.mjs` 现在对生产依赖执行确定性的 allow/review/deny：未知或未经审查的许可证会失败，GPL、AGPL 和 SSPL 等拒绝项会失败；DOMPurify 的双许可证被明确选择为 Apache-2.0。脚本读取每个生产包内的许可证文本并生成 `THIRD-PARTY-NOTICES.txt`。

本次检查覆盖 8 个生产依赖并通过。生成文件包含全部 8 个依赖段落，其中 DOMPurify 段落标明声明许可证 `(MPL-2.0 OR Apache-2.0)`、分发选择 `Apache-2.0`，并附带完整 Apache-2.0 文本。发行目录通过 `extraResources` 携带该文件，同时继续保留 Electron/Chromium 自带 notices。

许可证脚本使用项目锁定的 Node 24.18.0 所附 Corepack；本机解析路径存在，冻结安装与 `licenses:check` 均成功。后续更换 Node 分发方式时须把该路径假设纳入工具链升级验证。

### [已解决 P2] package payload 测试不能证明 asar 白名单

package smoke 现在使用精确锁定的直接开发依赖 `@electron/asar@3.4.1` 枚举归档并读取文件内容。新产物的 `app.asar` 只有 7 个文件：

```text
apps\desktop\out\main\index.js
apps\desktop\out\preload\index.cjs
apps\desktop\out\renderer\assets\editor.worker-BwBjdhCz.js
apps\desktop\out\renderer\assets\index-0IS_NFft.js
apps\desktop\out\renderer\assets\index-3JidIxZT.css
apps\desktop\out\renderer\index.html
package.json
```

归档路径逐项匹配允许模式，文本内容扫描没有发现开发 URL、`ELECTRON_RENDERER_URL`、凭据标记、开发机绝对路径或 fixture 引用。整个 `win-unpacked` 也没有 source map、Python、DOC/DOCX、PDF、PPT/PPTX 或测试 fixture。

### [已解决 P2] main/preload 的 `skipLibCheck` 豁免过宽

`apps/desktop/tsconfig.node.json` 已恢复继承基线的 `skipLibCheck: false`，main 与 preload 接受完整声明检查。electron-vite 可选 SWC 类型问题被隔离到独立 tooling tsconfig；根测试工具图的 happy-dom 上游兼容例外也有具体注释，不会传递给 main/preload 或 workspace package。

### [已解决 P2] package build 把测试输出到 `dist`

各 package build tsconfig 已排除 `*.test.ts(x)`。重新执行 build 后，`packages/**/dist` 中没有测试文件；package smoke 也将此条件固化为回归断言。

### [已解决 P3] 不必要地允许 `electron-winstaller` install script

pnpm 11.20.0 的 `allowBuilds` 现在对 `electron-winstaller` 显式设为 `false`，没有允许其 install script。`pnpm ignored-builds` 报告它是唯一显式忽略项，没有自动忽略项；冻结安装和 Windows x64 directory 打包均成功，因此 directory-only 目标不依赖该脚本。

## 重新验证记录

```text
corepack pnpm install --frozen-lockfile   PASS (pnpm 11.20.0)
corepack pnpm licenses:check              PASS (8 production dependencies)
corepack pnpm verify                      PASS
  format / lint / typecheck / build       PASS
  unit                                    PASS (1 test)
  component                               PASS (1 test)
corepack pnpm test:e2e                    PASS (1 test)
corepack pnpm package:dir                 PASS (Windows x64 win-unpacked)
corepack pnpm test:package                PASS (4 tests)

host Node                                 24.18.0
packaged Electron                         43.3.0
app.asar files                            7
hostile renderer env probe                BLOCKED
actual fuse wire                          0/1/0/0/1/1/0/1
emitted dist test files                   0
forbidden packaged document/source files  0
```

## 批准结论

最小工程骨架现已满足 `0001-engineering-baseline-review.md` 的退出条件：固定工具链可冻结安装，main/preload/renderer 边界和 renderer sandbox 可验证，Monaco worker 在真实 Electron 和便携目录中运行，打包应用不接受外部 renderer 覆盖，fuse wire 有明确基线，生产依赖许可证和实际 payload 有自动门禁，Windows x64 便携目录可启动。

因此批准该骨架作为下一阶段依赖。后续模块不得借此批准扩大 preload bridge、放宽 CSP、引入原生扩展、跳过模块独立审查，或把当前 `file:` 权限例外视为永久决定。
