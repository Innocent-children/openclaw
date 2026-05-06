# Requirements Document

## Introduction

Knowledge Bridge Plugin（以下简称 KB 插件）是一个 OpenClaw 插件（`extensions/knowledge-bridge/`），
其核心职责是：在 OpenClaw 接收到用户入站消息之后、在进入模型调用之前，调用本地 Knowledge Bridge
服务（`http://127.0.0.1:8111`）的 `/api/v1/query` 端点，获取与用户问题相关的知识证据包
（`sources` + `instructions` + `route`），并将其合入 LLM 的 system/developer prompt 与上下文中，
从而以"可控的、带审计的知识库外脑"模式约束模型回答。

本插件只通过 `openclaw/plugin-sdk/*` 公共契约与 OpenClaw core 交互：

- 通过 manifest（`openclaw.plugin.json`）声明插件元数据与 hook 订阅；
- 通过 `api.on("message_received", ...)` 观察入站消息，派生调用上下文；
- 通过 `api.on("before_prompt_build", ...)` 在 prompt 构建前注入 `systemPrompt` /
  `prependSystemContext` / `appendContext`；
- 通过插件自身的配置契约（typed config）声明 Base URL、共享密钥来源、超时、开关、每渠道启用等。

V1 范围严格聚焦于 `/api/v1/query` 调用与上下文注入，不包含任何入库（ingest）相关能力。

## V1 Out of Scope

以下能力在 V1 明确不交付、不暴露配置、不进入代码路径，也不占用需求编号；后续版本可能重新评估：

- `/api/v1/ingest/candidate` 自动候选沉淀调用链（含 `worthy`、`duplicate`、`taskId` 的处理与日志）
- `/api/v1/ingest/manual` 手动入库调用链
- 任何手动入库触发指令（示例：`#入库`、`/kb add`）及其合成回复
- `/api/v1/ingest/status/{taskId}` 入库状态查询
- 与入库相关的 `sourceType` 渠道映射、`attachments` 透传、`force` 去重绕过策略
- 与入库相关的操作员可观测指标（`worthy`、`duplicate`、`taskId`、`reason` 等）

V1 配置契约、Glossary、需求编号、测试属性均按"只做查询"的最小闭环组织；当后续版本重新启用
ingest 链路时，需要重走 requirements → design → tasks 流程新增编号需求，而不是复用本文档的
既有编号。

## Glossary

- **KB_Plugin**: 本次交付的 OpenClaw 插件运行时，即 `extensions/knowledge-bridge/` 产出的单元。
- **KB_Service**: 外部 Knowledge Bridge HTTP 服务，Base URL 默认 `http://127.0.0.1:8111`。
- **KB_Query_Client**: KB_Plugin 内部负责构造、签名、发送 `/api/v1/query` 请求并解析响应的模块。
- **KB_Signer**: 负责根据 `KB_SHARED_SECRET` 生成 `X-KB-RequestId`、`X-KB-Timestamp`、
  `X-KB-Signature` 的签名组件。
- **KB_Context_Injector**: 负责把 `sources` 与 `instructions` 转换为 LLM system/developer
  prompt 片段、通过 `before_prompt_build` hook 注入到当前 agent turn 的模块；
  也负责在 `/query` 失败时注入 `Knowledge_Bridge_Status` 降级片段。
- **KB_Config**: KB_Plugin 的配置对象，字段见 Requirement 7。
- **Query_Context**: 从 OpenClaw 消息与会话派生的调用上下文，至少包含 `userId`、
  可选的 `chatId`、`sessionKey`、`messageId`、`channelType`、`isGroup`、`question`。
- **Evidence_Bundle**: `/query` 成功响应的结构化结果：`route` ∈
  {`KB_ONLY`, `KB_PLUS_LLM`, `LLM_ONLY`}、`allowModelSupplement`、`sources[]`、
  `instructions[]`、`retrievalQuality { hitCount, confidence, truncated,
originalHitCount }`。
- **Route**: `Evidence_Bundle.route` 的取值，控制模型可依据的证据范围。
- **Confidence**: `retrievalQuality.confidence` 的取值 `HIGH | MEDIUM | LOW`。
- **Body_Hash**: `SHA-256(requestBody)` 的十六进制小写字符串。
- **Signature_Content**: `requestId + timestamp + Body_Hash` 三段直接拼接。
- **Query_Outcome**: `/query` 单次调用的终态分类，取值集合为
  {`success`, `timeout`, `http_error`, `schema_error`, `signature_error`,
  `config_missing`, `disabled`}，用于日志事件与降级片段的稳定标签。
- **Knowledge_Bridge_Status_Segment**: 在 `/query` 失败（`Query_Outcome !== success`）
  时由 KB_Context_Injector 注入的确定性 system 片段，包含 `Knowledge_Bridge_Status:
QUERY_FAILED` 标题、`Query_Outcome` 分类标签、人类可读降级说明，以及给模型的"在最终
  回答末尾告知用户知识库当前不可用"指令。
- **Credential_Store**: OpenClaw 维护的本地凭据目录 `~/.openclaw/credentials/`，
  用于存放 channel/provider 凭据；KB_Plugin 的共享密钥从其中按 `credentialKey`
  读取，与 AGENTS.md 中"channel/provider creds in `~/.openclaw/credentials/`"的约定一致。

Out of scope (V1)：`KB_Ingest_Client`、`Ingest_Trigger` 等 ingest 相关术语在 V1 不定义、
不使用；若未来重启 ingest 链路再行补充。

## Assumptions and Open Decisions

以下为 V1 已确认的假设，若后续评审要修改会同步更新相关 Acceptance Criteria：

- A1: V1 只对"用户发起的入站消息"触发 `/query`；系统自发消息、插件合成回复、bot-to-bot 消息、
  已被 `inbound_claim` 短路的消息不触发（避免无限回环）。
- A2: 群聊与私聊都默认触发；`KB_Config.perChannel` 允许按 `channelType` 或 `isGroup` 关闭。
- A3: 注入方式采用 `before_prompt_build` hook，`instructions` 拼入 `prependSystemContext`，
  `sources` 以结构化文本块形式拼入 `appendContext`，不写入持久化对话历史，也不走 tool
  result/capability 通道。
- A4: `route === KB_ONLY` 或 `allowModelSupplement === false` 时，KB_Plugin 会在注入的
  system 片段中明确加入"仅依据提供的 sources 回答，若不足请说明知识库无相关信息"指令。
- A5: `hitCount === 0` 或 `confidence === "LOW"` 时，V1 仍完成一次注入（至少包含 `route`
  与 `instructions`），但会在 system 片段中标注 `retrievalConfidence=LOW`；不向用户
  主动提示。
- A6: 任何 `/query` 失败（网络/DNS/TLS/超时、HTTP 非 2xx、body/schema 非法、签名或
  密钥配置缺失）均采取"放行原始对话 + 注入降级提示片段 + 记录 structured error"
  的策略，不中断 agent turn；V1 不做重试。降级提示片段让模型在最终回答末尾告知用户
  "知识库当前不可用，以下回答来自模型自身知识"。
- A7: V1 只实现 `/api/v1/query` 调用与上下文注入链路；`/api/v1/ingest/*`（`candidate` /
  `manual` / `status`）与任何入库触发指令明确不在 V1 范围（见 "V1 Out of Scope"）。
- A8: `KB_SHARED_SECRET` 只从 OpenClaw 凭据存储 `~/.openclaw/credentials/` 读取，
  不从环境变量读取，也不以原文形式写入 `KB_Config`、日志或任何持久化文件；配置中
  只保留 `credentialKey` 这一"引用"。
- A9: 插件不读取/写入 core 内部或其他 extension 的 `src/**`；所有 OpenClaw 交互都走
  `openclaw/plugin-sdk/*` 与 manifest。

## Requirements

### Requirement 1: 插件声明与生命周期

**User Story:** 作为 OpenClaw 维护者，我希望 KB_Plugin 以标准插件形式被发现与激活，
以便操作员可以像其他 bundled 插件一样启用/配置它。

#### Acceptance Criteria

1. THE KB_Plugin SHALL 提供一个 `openclaw.plugin.json` manifest，其中声明插件 id
   `knowledge-bridge`、人类可读名称、版本、入口文件、所需 hook 订阅集合
   （至少包含 `message_received` 与 `before_prompt_build`）。
2. THE KB_Plugin SHALL 通过 `openclaw/plugin-sdk/plugin-entry` 的 `definePluginEntry`
   暴露入口，且不在入口文件中对 core `src/**`、其他 extension 的 `src/**`、或
   `src/plugin-sdk-internal/**` 产生直接或传递依赖。
3. THE KB_Plugin SHALL 导出一个带 Zod 或 SDK 提供的 schema 校验器的 typed `KB_Config`
   契约，并通过 manifest / `hooks.timeoutMs` 以外的标准配置入口暴露给操作员。
4. WHEN OpenClaw Gateway 启动时加载插件清单， THE KB_Plugin SHALL 在不访问
   `KB_Service` 的前提下完成注册（即 manifest/注册路径无网络 I/O 副作用）。
5. WHERE `KB_Config.enabled === false`， THE KB_Plugin SHALL 跳过所有 `message_received`
   与 `before_prompt_build` 决策逻辑，且不产生任何 `KB_Service` 请求，也不注入任何
   上下文片段。

### Requirement 2: 入站消息触发与 Query_Context 派生

**User Story:** 作为操作员，我希望 KB_Plugin 在用户每次发送消息时精确触发且能正确采集
调用上下文，以便 KB_Service 能得到完整的查询信号。

#### Acceptance Criteria

1. WHEN `message_received` hook 被调用且事件来源为人类用户的入站消息，
   THE KB_Plugin SHALL 从事件上下文派生一个 Query_Context，并将其标记为"待 query"
   绑定到当前 `ctx.sessionKey` 与 `ctx.messageId`。
2. THE Query_Context.userId SHALL 取自 `ctx.senderId`，不存在时回退到稳定的会话级
   匿名 ID（基于 `ctx.sessionKey` 派生且在插件生命周期内一致）。
3. WHERE `ctx.threadId` 存在， THE Query_Context.chatId SHALL 取自 `ctx.threadId`。
4. THE Query_Context.sessionKey SHALL 取自 `ctx.sessionKey` 当存在。
5. THE Query_Context.messageId SHALL 取自 `ctx.messageId` 当存在。
6. THE Query_Context.channelType SHALL 取自 `ctx.messageProvider` 当存在。
7. THE Query_Context.isGroup SHALL 取自 `ctx.threadId !== undefined` 与渠道 metadata
   的组合，具体映射由渠道适配表给出；当无法判定时 isGroup 为 false。
8. THE Query_Context.question SHALL 等于 `message_received` 事件中的文本内容
   （`content` 或 SDK 暴露的等价字段），不得额外拼接其他历史消息。
9. IF 入站消息被判定为 bot/系统/合成消息（如 `ctx.isSynthetic === true` 或
   `inbound_claim` 已被其他插件短路）， THEN THE KB_Plugin SHALL 跳过 KB_Service 调用
   且不注入任何上下文。
10. WHERE `KB_Config.perChannel[channelType] === false`， THE KB_Plugin SHALL 跳过
    KB_Service 调用且不注入任何上下文。

### Requirement 3: HMAC 签名与请求构造

**User Story:** 作为安全评审者，我希望每一个 `/query` 请求都被 KB_Signer 正确签名，
以便 KB_Service 端可以稳定验签。

#### Acceptance Criteria

1. WHEN KB_Query_Client 准备发送 `/api/v1/query` 请求， THE KB_Plugin SHALL
   生成一个版本为 v4 的 UUID 作为 `requestId`，且同一个值同时出现在 HTTP
   header `X-KB-RequestId` 与请求体 `requestId` 字段中。
2. THE KB_Plugin SHALL 将 `X-KB-Timestamp` 设为当前 Unix 毫秒时间戳
   （`Date.now()` 或 SDK 提供的等价时钟），且在单次请求内该值与签名使用的
   `timestamp` 严格相同。
3. THE KB_Signer SHALL 按以下公式计算签名：`Body_Hash = SHA-256(requestBody)` 十六进制
   小写；`Signature_Content = requestId + timestamp + Body_Hash`（无分隔符）；
   `X-KB-Signature = Base64(HMAC-SHA256(Signature_Content, KB_SHARED_SECRET))`。
4. FOR ALL 相同的 `(requestId, timestamp, requestBody, KB_SHARED_SECRET)` 四元组，
   THE KB_Signer SHALL 产生相同的 `X-KB-Signature`（确定性签名属性）。
5. FOR ALL `(requestId, timestamp, KB_SHARED_SECRET)` 固定而 `requestBody` 字节不同的
   请求， THE KB_Signer SHALL 产生不同的 `X-KB-Signature`（Body_Hash 区分属性）。
6. THE KB_Plugin SHALL 从 Credential_Store（`~/.openclaw/credentials/`）按
   `KB_Config.sharedSecretRef.credentialKey` 指定的 key（默认
   `"knowledge-bridge/shared-secret"`）读取共享密钥，不支持从环境变量或 `KB_Config`
   原文字段读取；读取路径与约定遵循 AGENTS.md "channel/provider creds in
   `~/.openclaw/credentials/`"。
7. IF Credential_Store 中不存在对应 `credentialKey`、或读到的密钥长度为 0、或读取时
   发生 I/O 错误， THEN THE KB_Plugin SHALL 在启动与首次调用时各记录一次结构化配置错误
   （`Query_Outcome = config_missing`），并使 KB_Query_Client 直接进入降级放行路径
   （参见 Requirement 6）。
8. THE KB_Plugin SHALL NOT 把共享密钥原文写入 `KB_Config`、日志、错误消息、
   hook 事件 payload、指标、告警或任何持久化文件；配置中只保留 `credentialKey`
   这一"引用"。

### Requirement 4: /query 调用与响应解析

**User Story:** 作为 LLM 使用者，我希望 KB_Plugin 能稳定调用 `/api/v1/query` 并把返回
的 Evidence_Bundle 正确解析成插件内部结构。

#### Acceptance Criteria

1. THE KB_Query_Client SHALL 向 `${KB_Config.baseUrl}/api/v1/query` 发送
   `POST` 请求，`Content-Type: application/json`，body 为 JSON 编码的 Query_Context
   加上 `flags.strictKbOnly = KB_Config.strictKbOnlyDefault`、
   `flags.needCitation = KB_Config.needCitationDefault`。
2. WHEN KB_Service 返回 HTTP 2xx 且 body 可解析为 Evidence_Bundle，
   THE KB_Query_Client SHALL 通过 schema 校验 `route`、`allowModelSupplement`、
   `sources[]`、`instructions[]`、`retrievalQuality` 字段类型，并将
   `Query_Outcome` 标记为 `success`。
3. IF 响应 body 缺少必填字段或 `route` 不在
   {`KB_ONLY`, `KB_PLUS_LLM`, `LLM_ONLY`} 集合内， THEN THE KB_Query_Client SHALL
   将 `Query_Outcome` 标记为 `schema_error` 并进入降级路径（Requirement 6）。
4. THE KB_Query_Client SHALL 接受请求级超时 `KB_Config.timeoutMs`（默认 3000ms），
   到期后取消底层请求，将 `Query_Outcome` 标记为 `timeout` 并进入降级路径。
5. THE KB_Query_Client SHALL 将解析后的 Evidence_Bundle（或降级信息，即
   `Query_Outcome` 与可选分类细节）绑定到当前 `ctx.sessionKey` + `ctx.messageId`
   - `ctx.runId` 组合的 in-memory cache 中，供同一 agent turn 的
     `before_prompt_build` hook 消费；turn 结束后该条目必须被释放。
6. FOR ALL `sources[]` 条目， THE KB_Query_Client SHALL 保留 `dataset`、`title`、
   `content`、`score`、`metadata` 原始字段顺序并按 `score` 降序排列（与响应保持一致），
   以维持 prompt cache 的确定性（Prompt cache 规则）。

### Requirement 5: 上下文注入到 LLM（before_prompt_build）

**User Story:** 作为模型调用者，我希望 Evidence_Bundle 被以正确的形态注入到模型
system/prompt 上下文，从而让模型的回答受到知识库约束。

#### Acceptance Criteria

1. WHEN `before_prompt_build` hook 被调用且当前 turn 存在已缓存的 Evidence_Bundle
   （`Query_Outcome === success`）， THE KB_Context_Injector SHALL 返回一个包含
   `prependSystemContext` 的决策结果。
2. THE KB_Context_Injector SHALL 在 `prependSystemContext` 中包含 Evidence_Bundle
   的 `instructions[]` 字面拼接、`route` 的中文可读标注、以及基于 `route` 与
   `allowModelSupplement` 的"回答边界"指令段。
3. THE KB_Context_Injector SHALL 在 `appendContext` 中包含一个标题为
   `Knowledge_Sources`（或等价固定字符串）的结构化块，其中按 `score` 降序列出每条
   source 的 `title`、`dataset`、`content`，并以稳定分隔符分隔。
4. WHEN `route === "KB_ONLY"` OR `allowModelSupplement === false`，
   THE KB_Context_Injector SHALL 在注入的 system 片段中包含"仅依据提供的
   Knowledge_Sources 回答；若证据不足，回答'知识库未收录该问题'"的显式约束句。
5. WHEN `route === "LLM_ONLY"` AND `sources[].length === 0`，
   THE KB_Context_Injector SHALL 仍注入一个最小的 system 片段，声明"本轮无
   Knowledge_Sources，按 LLM 自身知识回答"，以维持 prompt 结构稳定。
6. WHEN `retrievalQuality.confidence === "LOW"` OR `retrievalQuality.hitCount === 0`，
   THE KB_Context_Injector SHALL 在注入的 system 片段中显式标注
   `retrievalConfidence=LOW`，且不得改变 `route` 的执行语义。
7. THE KB_Context_Injector SHALL NOT 写入任何持久化的对话历史、session extension
   或 next-turn injection，以保证 Evidence_Bundle 只影响当前 agent turn。
8. FOR ALL 具有相同 Evidence_Bundle 的两次 turn， THE KB_Context_Injector SHALL 产生
   字节级相同的 `prependSystemContext` 与 `appendContext` 文本（确定性注入属性，
   支撑 prompt cache）。
9. WHERE 操作员在 `plugins.entries["knowledge-bridge"].hooks.allowPromptInjection`
   设为 `false`， THE KB_Plugin SHALL 不抛异常，且 `before_prompt_build` 返回空决策，
   保留原 prompt。

### Requirement 6: 失败与降级（含用户可见失败提示）

**User Story:** 作为运维者与终端用户，我希望 KB_Service 故障不会拖垮用户对话，同时用户
能在最终回答中知道"知识库当前不可用"，而不是得到一个看起来完全正常但实际上没有走知识库
的回答。

#### Acceptance Criteria

1. IF `/api/v1/query` 请求因网络错误、DNS 失败、TLS 错误、连接超时、读超时而失败，
   THEN THE KB_Plugin SHALL 将 `Query_Outcome` 标记为 `timeout` 或 `http_error`
   中更贴近的一类、记录一次结构化错误（含 `requestId`、`Query_Outcome` 分类），
   不重试、不阻塞 agent turn，并按 Requirement 6.8 注入 Knowledge_Bridge_Status_Segment。
2. IF `/api/v1/query` 响应 HTTP 状态码非 2xx，
   THEN THE KB_Plugin SHALL 将 `Query_Outcome` 标记为 `http_error`，按同样方式
   降级（不重试、不注入 Evidence_Bundle、注入 Knowledge_Bridge_Status_Segment）。
3. IF `/api/v1/query` 响应 body 解析失败或 schema 校验失败，
   THEN THE KB_Plugin SHALL 将 `Query_Outcome` 标记为 `schema_error`，按同样方式
   降级。
4. WHEN 请求耗时超过 `KB_Config.timeoutMs`，
   THE KB_Plugin SHALL 取消底层请求，将 `Query_Outcome` 标记为 `timeout`，按同样
   方式降级。
5. WHERE Credential_Store 中缺失 `sharedSecretRef.credentialKey` 对应的密钥、
   或读取时发生 I/O 错误， THE KB_Plugin SHALL 将 `Query_Outcome` 标记为
   `config_missing`，不发起任何 KB_Service 请求，按同样方式降级；启动日志中至少
   包含一次明确的结构化配置错误。
6. IF 签名构造过程本身失败（例如 HMAC 计算抛错、时钟异常），
   THEN THE KB_Plugin SHALL 将 `Query_Outcome` 标记为 `signature_error`，不发送
   请求，按同样方式降级。
7. THE KB_Plugin SHALL NOT 在任何失败分支阻塞或修改 agent turn 的原始用户输入与输出
   流程（除了下一条所述的降级片段注入）。
8. WHEN `Query_Outcome !== success` 且 `KB_Config.enabled === true`，
   THE KB_Context_Injector SHALL 在当前 agent turn 的 `before_prompt_build` 决策中
   注入一个 Knowledge_Bridge_Status_Segment，该片段：
   - 使用固定标题 `Knowledge_Bridge_Status: QUERY_FAILED`；
   - 携带 `Query_Outcome` 分类标签（取自 `{timeout, http_error, schema_error,
signature_error, config_missing}`）；
   - 包含一段面向 LLM 的人类可读说明与指令，要求模型"在最终回答末尾用一句话告知
     用户：当前知识库查询不可用，以下回答基于模型自身知识"；
   - 不包含原始异常堆栈、错误消息原文、`KB_SHARED_SECRET`、完整请求 body、完整
     `X-KB-Signature`、完整响应 body 或任何密钥/凭据字段。
9. FOR ALL 相同 `Query_Outcome` 分类的失败， THE KB_Context_Injector SHALL 产生
   字节级相同的 Knowledge_Bridge_Status_Segment 文本（确定性降级文案属性，支撑
   prompt cache）。
10. WHERE 操作员在 `plugins.entries["knowledge-bridge"].hooks.allowPromptInjection`
    设为 `false`， THE KB_Plugin SHALL 不注入 Knowledge_Bridge_Status_Segment，
    且 `before_prompt_build` 返回空决策（此时失败对用户不可见，但仍按 Requirement 8
    记录结构化事件）。
11. FOR ALL 失败分支与 Knowledge_Bridge_Status_Segment 的日志/事件记录，
    THE KB_Plugin SHALL NOT 将共享密钥原文、签名原文、完整请求/响应 body 写入
    错误日志或事件 payload（只允许摘要：`requestId`、HTTP 状态码、`Query_Outcome`、
    消息长度）。

### Requirement 7: 配置契约

**User Story:** 作为操作员，我希望通过统一的插件配置入口控制 KB_Plugin 的行为，而无需
修改插件代码，也不需要把密钥原文写进配置文件。

#### Acceptance Criteria

1. THE KB_Plugin SHALL 暴露 `KB_Config`，其字段恰好包括：
   - `enabled: boolean`（默认 `true`）
   - `baseUrl: string`（默认 `"http://127.0.0.1:8111"`）
   - `sharedSecretRef: { credentialKey: string }`（默认
     `{ credentialKey: "knowledge-bridge/shared-secret" }`；
     仅支持通过 `credentialKey` 从 Credential_Store 读取，不提供
     `envVar` 或原文字段）
   - `timeoutMs: number`（默认 `3000`）
   - `strictKbOnlyDefault: boolean`（默认 `false`）
   - `needCitationDefault: boolean`（默认 `false`）
   - `perChannel: Record<string, boolean>`（默认 `{}`）
2. THE KB_Plugin SHALL 在插件启动时以 schema 校验 `KB_Config`；任何校验失败 SHALL
   被视作"插件禁用"等价状态并记录结构化错误（`Query_Outcome = disabled` 或
   `config_missing`，按触发原因选择）。
3. THE KB_Plugin SHALL 在配置、schema、help、baseline、docs 之间保持一致
   （遵循仓库"Config contract"原则）；不得暴露任何 V1 Out of Scope 中列出的
   ingest 相关字段。
4. WHERE 操作员在运行时修改 `KB_Config.baseUrl`、`timeoutMs`、`strictKbOnlyDefault`、
   `needCitationDefault`、`perChannel`， THE KB_Plugin SHALL 在不重启 Gateway 的
   前提下令新值对下一次 `message_received` 生效。
5. WHERE 操作员修改 `sharedSecretRef.credentialKey` 或 Credential_Store 中对应的
   凭据内容， THE KB_Plugin SHALL 遵循 OpenClaw 标准凭据刷新语义（至少在 Gateway
   重启后生效）；任何情况下 KB_Plugin 都不得读取/接受配置文件中的密钥明文。

### Requirement 8: 观测与日志

**User Story:** 作为 SRE，我希望能稳定观测 KB_Plugin 的请求量、命中率、失败类别与耗时。

#### Acceptance Criteria

1. THE KB_Plugin SHALL 为每次 `/query` 调用（含未实际发出请求的 `config_missing` /
   `signature_error` / `disabled` 情形）记录一条结构化事件，字段至少包括：
   `requestId`、`sessionKey`（或其稳定哈希）、`channelType`、`isGroup`、
   `Query_Outcome`、`route`（仅 `success` 时存在）、`retrievalQuality.hitCount`
   （仅 `success` 时存在）、`retrievalQuality.confidence`（仅 `success` 时存在）、
   `durationMs`、`httpStatus`（仅 `http_error` 时存在）。
2. THE KB_Plugin SHALL NOT 在日志或事件 payload 中写入 `KB_SHARED_SECRET`、
   完整 `X-KB-Signature`、完整请求体、完整 `sources[].content` 或完整用户 question
   （只允许长度或前若干字符的摘要）。
3. THE KB_Plugin SHALL 为每次 Knowledge_Bridge_Status_Segment 的注入记录一条
   结构化事件，字段至少包括 `requestId`、`Query_Outcome`、`injected: true|false`
   （`allowPromptInjection === false` 时为 `false`），且不包含降级片段以外的
   任何错误原文。

### Requirement 9: 测试与正确性属性（PBT 友好）

**User Story:** 作为测试/质量负责人，我希望核心行为以可测试属性形式陈述，以便在后续
design 阶段直接映射到 vitest 与 property-based 测试。

#### Acceptance Criteria

1. FOR ALL 随机生成的合法 `(requestId: UUIDv4, timestamp: int53, bodyBytes: Uint8Array,
secret: NonEmptyString)` 四元组， THE KB_Signer SHALL 产生与独立实现
   （参考 Node `crypto.createHmac`）字节一致的 `X-KB-Signature`
   （签名参考等价属性）。
2. FOR ALL 随机生成的 `(requestId, timestamp, bodyBytes, secret)`， THE KB_Signer
   SHALL 对相同输入产生相同签名（确定性属性，对应 Requirement 3.4）。
3. FOR ALL 随机生成的 `bodyBytesA !== bodyBytesB` 而其他输入相同，
   THE KB_Signer SHALL 产生不同签名（Body_Hash 区分属性，对应 Requirement 3.5）。
4. FOR ALL 合法 Evidence_Bundle 输入与 `(route, allowModelSupplement, hitCount,
confidence)` 组合， THE KB_Context_Injector SHALL 对相同输入产生字节相同的注入
   文本（确定性注入属性，对应 Requirement 5.8）。
5. FOR ALL Evidence_Bundle 满足 `route === "KB_ONLY"`， THE KB_Context_Injector 的
   输出 SHALL 包含"仅依据提供的 Knowledge_Sources 回答"约束句
   （route 约束属性，对应 Requirement 5.4）。
6. FOR ALL Evidence_Bundle 满足 `allowModelSupplement === false`，
   THE KB_Context_Injector 的输出 SHALL 包含"不得补充 sources 以外的事实"约束句
   （allowModelSupplement 约束属性）。
7. FOR ALL 模拟 KB_Service 返回 `{ status, body }` 组合中 `status` 非 2xx 或 body
   非法， THE KB_Query_Client SHALL 返回失败结果且 `before_prompt_build` 决策包含
   一个 Knowledge_Bridge_Status_Segment 且不包含 Evidence_Bundle 注入
   （降级放行 + 用户可见提示属性，对应 Requirement 6.1-6.8）。
8. FOR ALL 模拟 `/query` 失败场景的 `Query_Outcome` 分类
   ∈ `{timeout, http_error, schema_error, signature_error, config_missing}`，
   KB_Context_Injector 注入的 Knowledge_Bridge_Status_Segment SHALL：
   - 包含与该 `Query_Outcome` 对应的分类标签；
   - 对同一分类产生字节一致的文本（降级文案确定性属性，对应 Requirement 6.9）；
   - 不包含 `KB_SHARED_SECRET` 原文、完整请求 body、完整 `X-KB-Signature`、
     完整响应 body（降级文案无泄漏属性，对应 Requirement 6.8 与 6.11）。
9. FOR ALL 执行路径， THE KB_Plugin SHALL 不把 `KB_SHARED_SECRET` 原文出现在任何
   被日志 sink 捕获到的字符串中（密钥不泄漏属性，对应 Requirement 3.8 与 6.11）。
10. WHEN 端到端测试使用本地 mock KB_Service 按公开规范响应 `/query`，
    THE KB_Plugin SHALL 使 mock 服务端验签通过（服务端可验签属性，对应
    Requirement 3.3）。

### Requirement 10: 仓库边界与交付制品

**User Story:** 作为架构评审者，我希望插件严格遵守仓库的 extension 边界规则，不污染 core
与其他 extension。

#### Acceptance Criteria

1. THE KB_Plugin SHALL 以 `extensions/knowledge-bridge/` 作为唯一源码根目录，
   所有生产代码的 import 只能来自以下来源：`openclaw/plugin-sdk/*`、
   本插件包内相对路径、以及该插件 `package.json` 中声明的运行时依赖。
2. THE KB_Plugin SHALL NOT import 任何来自 `src/**`、`src/plugin-sdk-internal/**`
   或其他 `extensions/*/src/**` 的模块。
3. THE KB_Plugin SHALL 在 `package.json` 中本地声明所有运行时依赖；任何新增依赖不进入
   仓库根 `package.json`，除非明确属于 `pnpm deps:root-ownership:check` 允许的
   bundled plugin 白名单。
4. THE KB_Plugin SHALL 通过现有的仓库质量门：`pnpm check:changed`、
   `pnpm test extensions/knowledge-bridge`、`pnpm check:architecture`、
   `pnpm plugin-sdk:api:check`、`oxfmt` / `oxlint` 包装器。
5. WHERE 新增的插件出口涉及 UI/Control 面板， THE KB_Plugin SHALL 更新
   `.github/labeler.yml` 与 GitHub labels（遵循仓库"新渠道/插件/应用/文档面"规则）。
