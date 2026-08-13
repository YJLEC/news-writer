# Stage 4 DeepSeek 客户端与任务执行编码前审查

日期：2026-08-09

状态：有条件批准。主 agent 固化本文两个编码前条件后，coding agent 才能实现 Stage 4；本文不批准 Electron IPC、凭据落盘、UI 或版本提交协议的重复实现。

## 审查范围与结论

Stage 4 必须存在：它负责把已经持久化的最终 Prompt 和配置转换为一次可取消、可超时、可审计的 DeepSeek 非流式请求，并把结果或安全错误交回现有领域/项目事务。当前 `packages/ai` 只有占位导出，现有模块没有网络适配、外部响应校验或任务执行隔离能力。

应直接复用：

- `packages/shared` 的 ID、时间、`SafeAppError` 和受限错误码；
- `packages/domain` 的九态任务机、Prompt/配置快照、取消边界和空正文禁止规则；
- `packages/project` 的单写者会话、状态提交、成功版本原子事务和恢复协议；
- Node.js 24.18.0 自带的 `fetch`、`AbortController`、Web Streams、`worker_threads` 和 `crypto`；
- 精确版本 `zod@4.4.3` 做外部请求/响应和 worker 消息的运行时校验。

不得在 `packages/ai` 复制任务状态机、项目存储、Prompt 持久化、版本创建或错误持久化。AI 模块只拥有 provider wire contract、传输、响应归一化和执行协调协议。

## 编码前条件

### 1. 固化首版模型目录和推理映射

截至 2026-08-09，DeepSeek 官方 Chat Completions 文档只列出：

- `deepseek-v4-flash`；
- `deepseek-v4-pro`。

现有测试和 fixture 使用 `deepseek-chat`，不能继续作为新任务默认值。历史项目中的任意模型字符串仍可读取和展示，但发起新请求时必须通过 Stage 4 的固定 allowlist；不支持的模型返回本地配置错误，不能发送网络请求。不得运行时抓取 `/models` 后静默改变用户选择或公开多供应商入口。

现有领域值 `off | low | medium | high` 可以保留，但 wire 映射必须固定且进入测试：

| 项目值 | `thinking.type` | `reasoning_effort` |
| --- | --- | --- |
| `off` | `disabled` | 省略 |
| `low` | `enabled` | `low` |
| `medium` | `enabled` | `medium` |
| `high` | `enabled` | `high` |

官方当前声明 `medium` 为兼容值并映射为 `high`。任务记录保存的是实际发送参数 `medium`，UI 应说明供应商当前会把它按 `high` 执行。`max` 暂不进入公开配置；若以后增加，必须先扩展领域 Schema 和迁移，不得在 AI adapter 中藏未持久化配置。

主 agent 必须指定新项目默认模型，建议 `deepseek-v4-pro`，并更新仅用于新任务的默认配置。历史 fixture 不需要伪装成当前可调用模型。

### 2. 为 HTTP 402 增加准确错误码

官方把 402 定义为余额不足。现有 `SafeAppError` 没有对应 code；把它映射为 `AUTH_REJECTED` 或 `SERVICE_UNAVAILABLE` 都会误导用户。实现前应在 `packages/shared` 增加稳定的 `INSUFFICIENT_BALANCE`，同步严格 Schema、测试和安全文案。该变更不扩大功能范围。

若主 agent 不批准新增错误码，Stage 4 应暂停，而不是用错误语义继续编码。

## 官方非流式契约基线

首版只调用固定 HTTPS endpoint：

```text
POST https://api.deepseek.com/chat/completions
Authorization: Bearer <API Key>
Content-Type: application/json
Accept: application/json
```

请求只包含经过 Schema 生成的字段：

```ts
{
  model: 'deepseek-v4-flash' | 'deepseek-v4-pro';
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  stream: false;
  thinking: { type: 'enabled' | 'disabled' };
  reasoning_effort?: 'low' | 'medium' | 'high';
  max_tokens: number;
}
```

不发送 tools、`response_format`、temperature、top_p、penalties、`user_id`、任意 extra body 或调用方 headers。base URL、headers 和 API Key 不属于项目/任务配置，也不能由 renderer 指定。

`maxWords` 不是 token 数，不能直接当作 `max_tokens`。coding 前应固定一个保守、确定的 wire 上限公式并写入 adapter policy 测试；建议 `min(32768, maxWords * 2 + 2048)`。Prompt 继续负责目标字数，超过内容验收限制的完整响应应失败，不得静默截断后造版。该 wire policy 由任务的配置快照和应用版本共同确定，不接受隐藏覆盖。

官方非流式响应是一个 Chat Completion JSON。实现至少校验：

- 顶层 `id`、`object=chat.completion`、`created`、`model` 和非空 `choices`；
- 请求 `n=1` 的隐含结果必须归一化为唯一 `index=0` choice；
- `message.role=assistant`，`message.content` 为 string 或 null；
- `finish_reason` 只接受文档枚举；
- usage 如存在，所有 token 计数为非负有限整数。

外部响应允许新增未知字段，但只能丢弃，不能传播到领域、日志或 IPC。先限制响应字节数，再解析 JSON 和运行 Zod；错误响应正文使用更小上限并仅在内存中参与分类。不得记录原始 body、headers、Prompt、`reasoning_content` 或 stack。

DeepSeek 当前会在耗时的非流式响应中发送空行 keep-alive。读取器必须允许 JSON 前后的空白，且空行不能重置客户端绝对 deadline。`reasoning_content` 可以校验为可选字符串，但首版不展示、不持久化、不拼回后续新闻稿 Prompt；最终版本只取 `message.content`。

## 完成原因和空响应规则

| `finish_reason`/结果 | Stage 4 结果 |
| --- | --- |
| `stop` + trim 后非空正文 | 成功候选，进入保存裁决点 |
| `length` | `CONTENT_INVALID`，提示输出被截断；不保存部分正文 |
| `content_filter` | `CONTENT_INVALID`；不泄露供应商原文 |
| `insufficient_system_resource` | `SERVICE_UNAVAILABLE`，可重试 |
| `tool_calls` | `PROTOCOL_INVALID`，因为首版未请求工具 |
| choice 缺失/重复、类型错误、非法 finish reason | `PROTOCOL_INVALID` |
| content 为 null、空串或纯空白 | `EMPTY_RESPONSE` |
| body 超限、JSON 截断或非 JSON | `PROTOCOL_INVALID` |

内容验收应在进入 `saving` 前运行。不要把供应商的 CoT、问题清单或内部说明当作新闻稿正文；具体产品内容规则复用阶段 1 黄金样例，不在 transport 中硬编码写作规则。

## 错误映射

只跨边界返回 `SafeAppError`。原始 URL、key、请求/响应 body、provider message、headers、worker stack 和绝对路径不得进入安全错误。

| 来源 | code | retryable |
| --- | --- | --- |
| 本地没有可用凭据 | `AUTH_REQUIRED` | false |
| HTTP 401 | `AUTH_REJECTED` | false |
| HTTP 402 | `INSUFFICIENT_BALANCE` | false |
| HTTP 429 | `RATE_LIMITED` | true |
| HTTP 500/503 | `SERVICE_UNAVAILABLE` | true |
| DNS、连接拒绝、TLS/连接中断 | `NETWORK_UNAVAILABLE` | true |
| 客户端 deadline 获胜 | `REQUEST_TIMEOUT` | true |
| 用户取消获胜 | `REQUEST_CANCELLED` | true，但文案说明服务端可能继续处理或计费 |
| HTTP 400/422 或其他明确请求 4xx | `PROTOCOL_INVALID` | false |
| 非法成功响应 | `PROTOCOL_INVALID`/`EMPTY_RESPONSE`/`CONTENT_INVALID` | false |
| worker 意外退出 | `TASK_INTERRUPTED` | true |

`Retry-After` 只接受有限的 delta-seconds，裁剪到现有 Schema 的 86400 秒；HTTP-date 或非法值首版可以忽略，不能自行用本地时区解析后持久化。

首版不自动重试。DeepSeek 没有为本调用承诺幂等键；连接在服务端完成后断开时，自动重试可能重复计费并生成不同正文。`retryable=true` 只允许 UI 提供用户明确发起的新任务。不能因 429/500/503 或网络错误在同一 task 内静默二次发送。

## 模块和接口边界

批准 `packages/ai` 内部按职责拆分，不要求为每个文件建立公开 package：

```text
packages/ai/
  contracts       request/result/worker message Zod Schema
  deepseek        fixed endpoint adapter and response mapping
  transport       bounded native fetch and absolute deadline
  execution       one-task coordinator and cancellation arbiter
  worker          one worker per active task
```

内部 OpenAI-compatible 边界只表达本产品实际需要的最小语义，例如：

```ts
interface ChatCompletionPort {
  complete(input: ChatCompletionInput, signal: AbortSignal): Promise<ChatCompletionResult>;
}
```

不得导出任意 URL、任意 JSON body、任意 headers、通用 provider registry 或 SDK client 给 renderer/preload。DeepSeek adapter 是首版唯一生产实现。

AI coordinator 不直接读取项目路径，也不创建 Version。受信任 host 提供：已从 Prompt artifact 校验并读取的消息、解析后的配置、内存 API Key、task ID，以及受序列化保护的领域状态提交 port。coordinator 只请求状态转换并返回最终正文候选；现有 project 成功事务拥有 `saving -> succeeded` 和 Version 创建。

API Key 只在受信任主进程取得后以一次性 worker 消息送入 worker。worker 不是安全沙箱，但 renderer 永远不能建立或监听该 channel。每个任务使用独立 worker，完成后终止，不建保存凭据的长期池。worker 不接收项目根、完整聚合、导出路径或日志对象。

## 状态语义

复用现有状态，不增加百分比：

| 状态 | 精确定义 |
| --- | --- |
| `queued` | 用户确认最终 Prompt 后，任务已持久化但未执行 |
| `preparing` | host 校验快照/配置/凭据、读取内容、扫描 secret 并启动 worker |
| `requesting` | 请求已准备并即将/已经交给 `fetch`，尚未接受 2xx headers |
| `processing` | 已接受 2xx headers，正在等待/读取完整 body；不声称服务端已进入某内部推理阶段 |
| `saving` | 完整响应和正文已校验，取消裁决已关闭，正在执行本地成功事务 |
| terminal | 复用 `succeeded/failed/cancelled/timedOut` |

HTTP 错误从 `requesting` 直接进入 `failed`。对非流式请求，`processing` 是客户端可观测的响应读取阶段，不应显示为虚构的模型百分比或供应商内部进度。

## 取消、超时和竞态

每个执行任务只有一个 coordinator、一个 `AbortController` 和一个单调时钟 deadline。`requestTimeoutMs` 从准备发出网络请求前开始，是绝对截止时间；收到 keep-alive、headers 或部分 body 都不延长。墙上时钟只用于持久化时间戳，不参与超时计算。

取消/超时/响应完成必须经过同一个串行裁决点：

1. 用户取消先登记 cancel intent 并 abort transport；若当前仍在 `queued/preparing/requesting/processing`，提交 `cancelled`，随后到达的响应一律丢弃。
2. deadline 先到时登记 timeout intent、abort transport并提交 `timedOut`；随后用户取消不得改写 terminal 原因。
3. 响应先完成时，先完成协议和内容校验，再在同一串行临界区复查 cancel intent 和单调 deadline。
4. 只有复查通过并成功提交 `processing -> saving` 后才能交给项目成功事务；此后取消按钮禁用，取消请求返回“已进入保存阶段”。
5. 若状态提交失败，绝不凭内存结果造版；重开按现有 project/task 恢复规则处理。

“先发生”由 coordinator 的事件序列决定，不用 `Promise.race` 后谁的 callback 恰好先被调度来猜。用户取消文案必须明确：应用已经停止等待，但供应商可能继续处理并计费。

worker 收到取消后 abort；若在短暂 grace period 内不退出，host 可以 terminate worker。意外 exit/error 且没有取消/超时 winner 时映射 `TASK_INTERRUPTED`。应用重开后，现有规则继续把 `queued/preparing/requesting/processing` 变为 failed + `TASK_INTERRUPTED`；`saving` 必须先执行项目事务恢复。

## 安全边界

- endpoint 和请求 headers 由 DeepSeek adapter 常量产生，禁止 SSRF 和 renderer header 注入。
- 在发送前用实际 API Key 精确比对所有消息；发现 key 出现在 Prompt 时硬阻断。再复用统一 secret-pattern scanner 发现常见凭据形态，但错误不得回显命中内容。
- 生产日志只允许 task ID、安全状态、HTTP 状态分类、耗时桶和 diagnostic ID；禁止 Prompt、正文、CoT、key、Authorization、响应 body 和原始异常。
- 成功/错误 body 都有读取上限；建议成功 8 MiB、错误 64 KiB。超限立即 abort 并返回安全协议错误。
- `fetch` 必须禁用非预期重定向（`redirect: 'error'`），避免 Authorization 被带到其他 origin。
- 不使用环境变量作为产品凭据来源；测试可以显式注入假 key，真实手工 smoke 由主进程凭据服务提供。

## 开源方案和依赖结论

### 批准

- Node.js 24.18.0 native `fetch`/Web Streams/AbortController：单 endpoint 足够，随已锁定运行时交付，无额外 ABI 或包体。
- Node.js `worker_threads`：Stage 4 的网络任务隔离实现；一项目最多一个 active task，与现有领域约束一致。
- `zod@4.4.3`：`packages/ai` 若直接调用 Zod，必须声明精确生产依赖，同时声明 `@news-writer/shared`、必要时声明 `@news-writer/domain` 的 workspace 依赖。

### 不批准

- `openai@7.4.0`（Apache-2.0，Node >=22）：成熟且官方示例采用，但约 12.5 MiB unpacked，覆盖远超单 endpoint 的 API，并带 SDK 自身超时/重试/错误语义。首版仍必须自行做 Zod、上限、取消裁决和安全映射，收益不足。
- `undici@7.29.0`（MIT，Node >=20.18.1）：Node 24 已提供满足需求的 fetch；直接依赖会重复运行时能力。
- `p-retry@8.0.0`（MIT，Node >=22）：首版明确不自动重试，加入会鼓励违反计费和非幂等边界。
- XState、队列框架、provider registry、长期 worker pool：现有任务机和单 active task 已足够，不增加第二套状态或调度系统。

## 测试门禁

### 纯单元测试

- 每个 reasoning/model 映射的精确 request golden；确认 `stream:false`、固定 endpoint、无多余字段。
- request/response/worker Schema 拒绝未知内部命令、非法 role、过长字段和伪造 terminal result。
- 所有 finish reason、null/空白 content、缺失/重复 choice、非法 usage、未知枚举和额外字段。
- 每个 HTTP/网络/abort/worker error 到 `SafeAppError` 的稳定映射；错误对象扫描不到 key、Prompt、body、Authorization、stack 和路径。
- Retry-After 合法、负数、超界和恶意字符串；确认不会自动重试。
- 使用 fake monotonic clock 和显式 barrier 穷举 response/cancel/timeout 三方顺序；禁止依赖真实毫秒 sleep 的竞态测试。

### 本地 HTTP 与真实 worker 集成测试

- 本地受控 server 返回正常 JSON、JSON 前空行、分块 keep-alive、延迟 headers、延迟 body、截断 JSON、错误 content-type、超限 body、连接 reset。
- deadline 不因空行或部分 body 重置；取消在发出前、等 headers、读 body 和保存裁决前均只产生一个 terminal 结果。
- 真实 worker 正常完成、主动取消、超时、异常 throw、非零 exit 和强制 terminate；进程无未关闭 handle。
- production adapter 的固定 origin 单独断言；本地 server 只能通过测试注入的 transport 使用，不能形成生产可配置 base URL。

### 领域/项目集成测试

- 使用真实 domain/project 会话跑 `queued -> ...` 的成功链和每条失败链。
- 401、402、429、500、503、网络断开、协议错误、空正文、取消、超时和 worker crash 后，`versions`、`latestVersionId` 和原正文 hash 完全不变。
- 结果校验后取消先赢时不得进入 saving；saving 先赢时取消被拒绝，并由现有成功事务只创建一个 Version。
- success commit 前后故障继续复用 Stage 2 的 transactionId/恢复测试；Stage 4 不另写简化保存路径。
- 重开 active task 得到 `TASK_INTERRUPTED`，saving task 走 commit 恢复，不出现 failed task 对应成功 Version 或成功空 Version。

### 安全与真实服务验收

- fixture 只使用明显虚构 key；全仓和便携包扫描无真实凭据、Prompt/响应转储或开发 endpoint。
- 单元/CI 不调用真实 DeepSeek，不产生费用或依赖外网。
- Stage 9 使用用户凭据做一次受控真实非流式 smoke，分别记录模型、实际发送 reasoning、状态序列和安全诊断；不记录 Prompt 正文、key 或 CoT。
- 手工验证取消文案不承诺服务端停止或不计费。

## Coding agent 获批范围

满足两个编码前条件后，批准 coding agent：

- 在 `packages/ai` 实现上述最小 contract、DeepSeek adapter、bounded native fetch、错误映射、单任务 coordinator 和真实 worker；
- 对现有 shared/domain 只做主 agent 明确批准的 402 错误码和新任务默认模型调整，不改变版本/批注/存储协议；
- 使用现有 domain/project port 集成状态提交和成功事务，不直接操作项目文件；
- 添加本文测试，不接 Electron renderer/preload，不实现凭据持久化或 UI。

暂缓或禁止：流式、Responses API、Anthropic API、tool calls、JSON mode、多轮 CoT、动态 provider、用户自定义 endpoint/headers、自动重试、并行任务和 SDK 替换。

## 最终批准结论

现有架构可执行，Stage 4 与 Stage 2 的任务/事务边界兼容。阻断编码的不是整体架构冲突，而是两个必须显式收口的当前契约问题：新任务默认模型不能再使用 `deepseek-chat`，HTTP 402 必须获得准确安全错误码。

主 agent 接受这两项并冻结本文的 wire、取消、超时和无自动重试规则后，批准 Stage 4 进入 coding agent。实现完成后仍需独立 post-review，重点检查竞态、凭据泄漏、响应上限和失败不造版。

## 参考资料

- DeepSeek Chat Completions API（2026-08-09 查阅）：https://api-docs.deepseek.com/api/create-chat-completion
- DeepSeek Models & Pricing（2026-08-09 查阅）：https://api-docs.deepseek.com/quick_start/pricing
- DeepSeek Thinking Mode（2026-08-09 查阅）：https://api-docs.deepseek.com/guides/thinking_mode
- DeepSeek Rate Limit & Isolation（2026-08-09 查阅）：https://api-docs.deepseek.com/quick_start/rate_limit
- DeepSeek Error Codes（2026-08-09 查阅）：https://api-docs.deepseek.com/quick_start/error_codes
- Node.js 24 fetch / AbortController / worker_threads：https://nodejs.org/docs/latest-v24.x/api/globals.html 、https://nodejs.org/docs/latest-v24.x/api/worker_threads.html
- npm `openai@7.4.0`、`undici@7.29.0`、`p-retry@8.0.0` 元数据（2026-08-09 查阅）。
