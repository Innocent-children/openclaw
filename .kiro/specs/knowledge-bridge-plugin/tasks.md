# Implementation Plan

本实现计划将 `design.md` 拆解为可顺序执行、每条独立可验证的 TypeScript 编码任务。所有任务聚焦于 `extensions/knowledge-bridge/` 包内的代码与测试产出；不含部署、发布、手工验证等非编码任务。

子任务中带 `*` 的为可选项（单元 / 属性 / 集成测试）；顶层任务不得标记可选。每个叶子任务在文本中以 `(Req X.Y)` / `(PN)` 形式嵌入对应的 Requirement ID 与 Property ID，顶层任务末尾汇总 `**Requirements:**` / `**Properties:**`。

实现语言：TypeScript（ESM，Node 22+）。PBT 库：`fast-check`（仅 devDependency，不进根 `package.json`）。Schema 库：`typebox`（runtime dep）。

## Tasks

- [ ] 1. 脚手架与 manifest
  - [x] 1.1 新建 `extensions/knowledge-bridge/` 目录并创建 `package.json`（`name=@openclaw/knowledge-bridge`、`type=module`、`version=2026.5.4`、`private=true`、`dependencies.typebox=1.1.37`、`devDependencies.fast-check` + `@openclaw/plugin-sdk` + `openclaw` workspace 引用、`peerDependencies.openclaw`、`openclaw.extensions=["./index.ts"]`），确保 `pnpm deps:root-ownership:check` 仍保持绿 (Req 10.1, 10.3, 2.1 包布局)
  - [x] 1.2 创建 `tsconfig.json`（extends `../tsconfig.package-boundary.base.json`），只声明本包源码根，不引用 core `src/**` (Req 10.1, 10.2)
  - [x] 1.3 创建 `openclaw.plugin.json` manifest：`id=knowledge-bridge`、`name`、`version`、`activation.onStartup=true`、hook 订阅 `message_received` + `before_prompt_build`、`configSchema` 与 design §3.2 完全一致（`additionalProperties:false`、`timeoutMs` 范围 250–120000、`sharedSecretRef.credentialKey` `minLength:1`） (Req 1.1, 7.1, 7.3)
  - [x] 1.4 创建空 `index.ts`：调用 `definePluginEntry({ id:"knowledge-bridge", name, description, configSchema, register: () => {} })`，register 回调保持 no-op，禁止任何 fetch / session extension / next-turn injection 调用 (Req 1.2, 1.4, 5.7)
  - [x] 1.5 创建空 `api.ts` barrel：仅 re-export `definePluginEntry` 返回类型与后续会导出的公共类型占位 (Req 10.1)
  - [x] 1.6 创建 `src/` 子目录结构占位（`src/__tests__/` 为空目录或放 `.gitkeep`），确认布局对齐 design §2.1

  **Verification:** `pnpm install && pnpm tsgo --filter @openclaw/knowledge-bridge && pnpm check:architecture && pnpm deps:root-ownership:check`
  **Requirements:** 1.1, 1.2, 1.4, 5.7, 7.1, 7.3, 10.1, 10.2, 10.3

- [-] 2. 配置解析 `src/config.ts`
  - [ ] 2.1 定义 `KBSharedSecretRef` / `KBConfig` TS 类型与对应 typebox schema，与 design §3.1、§3.2 完全一致 (Req 7.1)
  - [ ] 2.2 实现 `resolveKbConfig(raw: unknown): { ok: true; config: KBConfig } | { ok: false; reason: string }`，对缺失字段按 design §3.1 默认值填充、类型错误 / `additionalProperties` 违规 / `baseUrl` 非 URL / `timeoutMs` 越界一律返回 `{ok:false}`（触发"等同 enabled=false"路径） (Req 1.5, 7.1, 7.2)
  - [ ] 2.3 导出用于热更新的 `resolveFromApiPluginConfig(apiPluginConfig)` 包装，保证每次 `message_received` 入口可重新解析 (Req 7.4)
  - [ ]\* 2.4 `src/__tests__/config.test.ts`：fast-check 属性测试覆盖 **P17**（默认值填充 + 非法输入 reject），补充热更新 example 测试覆盖 Req 7.4 (P17, Req 1.5, 7.1, 7.2, 7.4)

  **Verification:** `pnpm test extensions/knowledge-bridge -- --run config`
  **Requirements:** 1.5, 7.1, 7.2, 7.3, 7.4
  **Properties:** P17

- [ ] 3. 凭据加载 `src/credentials.ts`
  - [ ] 3.1 实现 `resolveCredentialPath(credentialKey)`：先去除前导分隔符再用 `path.resolve` 与 `path.relative` 双重校验，拒绝逃逸 `~/.openclaw/credentials/` 的输入 (Req 3.6)
  - [ ] 3.2 实现 `loadKbSharedSecret(ref, opts)`：封装 `openclaw/plugin-sdk/secret-file-runtime` 的 `loadSecretFileSync({ rejectSymlink:true })`，ENOENT / 空文件 / symlink / 路径越界 / I/O 错误统一归类为 `{ ok:false, outcome:"config_missing" }`，并通过 `PluginLogger.warn("kb.credential.load_failed", { reason })` 记录；不得 stringify 原始错误或路径凭据字段 (Req 3.7, 6.5, 6.11, 8.2)
  - [ ] 3.3 成功路径返回 `{ ok:true, secret:Buffer, resolvedPath, mtimeMs }`；进程级 `Map<credentialKey, cache>` 每次签名前比对 `mtimeMs` 未变化即复用，变化即 reload (Req 7.5)
  - [ ] 3.4 红线：`secret` 只作为 `Buffer` 流转，不得出现在返回给 telemetry / event / 配置回显的任何字段 (Req 3.8)
  - [ ]\* 3.5 `src/__tests__/credentials.test.ts`：用 `vi.mock("openclaw/plugin-sdk/secret-file-runtime", …)` 模拟加载结果，断言 ENOENT / 空文件 / symlink reject / 越界路径 / I/O 错误 → `config_missing`；mtime 变化触发 reload；日志 payload 不含 secret bytes (Req 3.6, 3.7, 3.8, 6.5, 7.5)

  **Verification:** `pnpm test extensions/knowledge-bridge -- --run credentials`
  **Requirements:** 3.6, 3.7, 3.8, 6.5, 6.11, 7.5, 8.2

- [ ] 4. 签名 `src/signer.ts`
  - [ ] 4.1 实现 `computeBodyHashHex(body: Uint8Array): string`，基于 `node:crypto` `createHash("sha256")`，输出十六进制小写 (Req 3.3)
  - [ ] 4.2 实现 `signRequest({ body, requestId, timestampMs, secret }): SignedHeaders`，严格按 `signatureContent = requestId + timestampMs + bodyHash` 顺序拼接，`HMAC-SHA256` → Base64；返回四个 header（`X-KB-RequestId`、`X-KB-Timestamp`、`X-KB-Signature`、`Content-Type: application/json`） (Req 3.1, 3.2, 3.3)
  - [ ] 4.3 实现 `newRequestId()` 包装 `randomUUID()`（UUID v4），供上游固定随机以便 PBT (Req 3.1)
  - [ ]\* 4.4 `src/__tests__/signer.test.ts`：fast-check 属性测试，运行至少 `numRuns:100` —
    - **P1（与 Node 原生 HMAC 字节等价）** 独立重算后 `expect(actual).toBe(expected)` (P1, Req 3.3, 9.1)
    - **P2（签名确定性）** 同一输入两次调用字节相等 (P2, Req 3.4, 9.2)
    - **P3（Body_Hash 区分）** body 字节不同而其他输入相同时签名不等 (P3, Req 3.5, 9.3)

  **Verification:** `pnpm test extensions/knowledge-bridge -- --run signer`
  **Requirements:** 3.1, 3.2, 3.3, 3.4, 3.5, 9.1, 9.2, 9.3
  **Properties:** P1, P2, P3

- [ ] 5. Evidence schema `src/evidence-schema.ts`
  - [ ] 5.1 用 typebox 定义 `Route` / `Confidence` / `EvidenceSource` / `EvidenceBundle`，字段类型与 `api_openclaw.txt` 和 design §6.1 一致 (Req 4.2, 4.3)
  - [ ] 5.2 实现 `validateEvidenceBundle(raw: unknown): raw is EvidenceBundle`，底层用 typebox `Check`，必填字段缺失 / `route` 非法枚举 / `hitCount` 非整数 / `confidence` 非法都返回 false (Req 4.3, 6.3)
  - [ ] 5.3 导出 `EvidenceBundle` / `EvidenceSource` 等静态类型，供 injector / query-client 共享
  - [ ]\* 5.4 `src/__tests__/evidence-schema.test.ts`：fast-check 生成合法 bundle 做往返、再对每个字段做变异（删字段 / 替换类型 / `route` 非法值），断言 **P6** (P6, Req 4.2, 4.3)

  **Verification:** `pnpm test extensions/knowledge-bridge -- --run evidence-schema`
  **Requirements:** 4.2, 4.3, 6.3
  **Properties:** P6

- [ ] 6. Query_Context 派生 `src/context.ts`
  - [ ] 6.1 实现 `anonymousFromSession(sessionKey?)`：`"anon-" + sha256(sessionKey).slice(0,16)`，无 sessionKey 时返回 `"anon-unknown"` (Req 2.2)
  - [ ] 6.2 实现 `deriveIsGroup(ctx)`：基于 `ctx.threadId` 存在性与 `ctx.channelMetadata?.isGroup` 的 OR 组合，无法判定时返回 false (Req 2.7)
  - [ ] 6.3 实现 `extractTextContent(event)`：仅读取 `event.content` 字符串字段，非字符串返回空串；不得拼接历史消息 (Req 2.8)
  - [ ] 6.4 实现 `isNonTextInbound(event)`：返回 true 时 dispatcher 直接 skip（design §7.2，风险 3）(Req 2.1)
  - [ ] 6.5 实现 `isInboundSynthetic(ctx, event)`：封装 `ctx.isSynthetic === true` + fallback（design §16 风险 1） (Req 2.9)
  - [ ] 6.6 实现 `buildQueryContext(event, ctx, cfg): QueryPayload`，按 design §7.3 映射 `userId / chatId / sessionKey / messageId / question / channelType / isGroup / flags`，`flags.strictKbOnly` 和 `flags.needCitation` 取 `cfg.strictKbOnlyDefault` / `cfg.needCitationDefault`，`requestId` 通过注入的 `newRequestId` 生成以便 PBT (Req 2.1–2.8, 4.1, 7.1)
  - [ ]\* 6.7 `src/__tests__/context.test.ts`：
    - fast-check 覆盖 **P4**（字段映射不变量） (P4, Req 2.1–2.8)
    - 属性测试覆盖 **P5**（perChannel skip：`perChannel[ch] === false` 时 dispatcher 不调用 fetch、不写 cache、`before_prompt_build` 返回 undefined；本文件只断言 `context` 模块层面的 skip 判定，全链路在 index.test.ts 闭环） (P5, Req 2.10)
    - example 测试：`ctx.isSynthetic === true` 与非文本 inbound 触发 skip (Req 2.9, 风险 3)

  **Verification:** `pnpm test extensions/knowledge-bridge -- --run context`
  **Requirements:** 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 4.1, 7.1
  **Properties:** P4, P5

- [ ] 7. Turn cache `src/turn-cache.ts`
  - [ ] 7.1 实现 `cacheKey(ctx)` = `"${ctx.sessionKey ?? ""}|${ctx.messageId ?? ""}|${ctx.runId ?? ""}"`，保证 key 在 dispatcher 两端对齐 (Req 4.5)
  - [ ] 7.2 实现 `TurnCache` 类：`set(key, value)` 写入并启动 120s 硬 TTL `setTimeout`；`takeAndDelete(key)` 读取并立即删除；支持注入时间源以便测试；TTL 淘汰时触发回调 `onExpire(key)`（供 telemetry 发 `KB_INJECTION_EVENT { reason: "cache_expired" }`） (Req 4.5)
  - [ ] 7.3 导出的公共 API 仅 `cacheKey`、`TurnCache`、`CacheEntry` 类型；内部 Map 不外泄 (Req 4.5, 5.7)
  - [ ]\* 7.4 `src/__tests__/turn-cache.test.ts`：fast-check 覆盖 **P7**（consume-once + key 隔离 + 多 key 互不干扰），example 测试覆盖 TTL 到期后自动清理与 `onExpire` 回调触发 (P7, Req 4.5)

  **Verification:** `pnpm test extensions/knowledge-bridge -- --run turn-cache`
  **Requirements:** 4.5
  **Properties:** P7

- [ ] 8. Telemetry `src/telemetry.ts`
  - [ ] 8.1 实现 `hashSessionKey(s?)` = `sha256(s).slice(0,24)`（无 sessionKey 返回 `"anon"`） 与 `summarizeText(text, n=64)`（仅用于调试日志，禁止进 event payload） (Req 6.11, 8.2)
  - [ ] 8.2 定义 `KbQueryEvent` / `KbInjectionEvent` TS 类型，字段严格限定在 design §10.1 / §10.2 白名单内；实现构造函数 `emitQuery(args)` / `emitInjection(args)` 负责组装事件并通过 `PluginLogger`（或 SDK event sink）发出 (Req 8.1, 8.3)
  - [ ] 8.3 在构造器内部执行字段白名单过滤：`route` / `hitCount` / `confidence` 仅在 `outcome==="success"` 时出现；`httpStatus` 仅在 `outcome==="http_error"` 时出现；任何输入中出现的 `secret` / signature / 完整 body / 完整 question 被显式过滤 (Req 6.11, 8.1, 8.2, 8.3, 9.9)
  - [ ] 8.4 导出 `KB_QUERY_EVENT_KIND = "kb.query"` 与 `KB_INJECTION_EVENT_KIND = "kb.injection"` 常量，供事件 subscriber / 测试双向引用 (Req 8.1, 8.3)
  - [ ]\* 8.5 `src/__tests__/telemetry.test.ts`：fast-check 覆盖 **P16**（事件 key 集合严格 ⊆ 白名单、条件字段只在对应 outcome 出现、JSON 序列化不含 secret/signature），example 测试覆盖 `summarizeText` 不进 event payload (P16, Req 8.1, 8.2, 8.3, 9.9)

  **Verification:** `pnpm test extensions/knowledge-bridge -- --run telemetry`
  **Requirements:** 6.11, 8.1, 8.2, 8.3, 9.9
  **Properties:** P16

- [ ] 9. Injector `src/injector.ts`
  - [ ] 9.1 实现 `renderSuccess(bundle, cfg)`：按 design §8.2 字面拼接 `prependSystemContext`（Header + Route + Instructions + Retrieval_Quality + lowConfidenceMarker + Answer_Boundary），`bulletedInstructions` 空数组时输出 `"  (无额外指令)"`；`lowConfidenceMarker` 条件输出 `"  retrievalConfidence=LOW"` 或空字符串 (Req 5.1, 5.2, 5.6, 5.8)
  - [ ] 9.2 实现 `boundaryClause` 选择：严格按 design §8.2 的四分支表映射 `(route, allowModelSupplement, sources.length)` → 字面句；模板字面量包含"仅依据提供的 Knowledge_Sources 回答"、"不得补充 Knowledge_Sources 以外的事实"、"本轮无 Knowledge_Sources"、"不得编造未在 Knowledge_Sources 中出现的事实" / "优先依据 Knowledge_Sources" 等关键句 (Req 5.4, 5.5, 9.5, 9.6)
  - [ ] 9.3 实现 `appendContext` 渲染：标题 `"# Knowledge_Sources"`，使用 `[...sources].sort((a,b) => b.score - a.score)` 稳定降序，`score.toFixed(4)` 字节稳定格式化，block 之间以 `"\n---\n"` 分隔 (Req 4.6, 5.3)
  - [ ] 9.4 实现 `renderStatusSegment(outcome)`：严格按 design §8.3 字面模板返回仅含 `prependSystemContext` 的对象；`outcomeLabel` 取 `{timeout, http_error, schema_error, signature_error, config_missing}`；不插入 requestId、时间戳、错误消息、HTTP status、URL、路径、密钥长度 (Req 6.8, 6.9, 6.11, 9.7, 9.8)
  - [ ] 9.5 红线：禁止在模板路径内使用 `Date.now()` / `Math.random()` / `toLocaleString` / `Intl.*` / Map/Set 迭代；`JSON.stringify` 仅允许出现在 query-client，不得出现在本模块 (Req 5.8, 6.9)
  - [ ]\* 9.6 `src/__tests__/injector.test.ts`：fast-check 覆盖
    - **P8（注入确定性）** 相同输入两次调用字节相等（success 模板 & status 模板） (P8, Req 5.8, 6.9, 9.4)
    - **P9（稳定降序 + 结构锚点）** source blocks `score` 单调不增、`prependSystemContext` 含 `"Route: "+route` / `"Instructions:"` / `"Retrieval_Quality:"` / `"Answer_Boundary:"`、`appendContext` 以 `"# Knowledge_Sources"` 开头且 block 间为 `"\n---\n"` (P9, Req 4.6, 5.2, 5.3)
    - **P10（边界约束句不变量）** 按 route/allowModelSupplement/sources.length 四分支分别断言字面子串存在 (P10, Req 5.4, 5.5, 9.5, 9.6)
    - **P11（LOW 置信标记）** iff `confidence==="LOW" || hitCount===0` (P11, Req 5.6)
    - **P13（Status_Segment 三要素 + 确定性 + 不泄漏）** 断言 `"Knowledge_Bridge_Status: QUERY_FAILED"` / `"Query_Outcome: "+outcome` / `"知识库当前不可用"` / `"以下回答来自模型自身知识"` 均存在，两次调用字节相等，输出不含 secret 字节 / HTTP status 数字 / URL / 错误堆栈 (P13, Req 6.8, 6.9, 6.11, 9.7, 9.8)
    - example 测试：`allowPromptInjection === false` 时 dispatcher 层返回 `undefined`（本文件仅验证 injector 函数返回值稳定，allowPromptInjection 闸口在 dispatcher 测）

  **Verification:** `pnpm test extensions/knowledge-bridge -- --run injector`
  **Requirements:** 4.6, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.8, 6.8, 6.9, 6.11, 9.4, 9.5, 9.6, 9.7, 9.8
  **Properties:** P8, P9, P10, P11, P13

- [ ] 10. Query client `src/query-client.ts`
  - [ ] 10.1 实现 `stableStringify(payload: QueryPayload)`：显式按 `{ requestId, userId, chatId?, sessionKey?, messageId?, question, channelType?, isGroup, flags }` 固定 key 顺序构造字符串，避免 `JSON.stringify` 实现差异；`flags` 内部亦按 `{ strictKbOnly, needCitation }` 顺序 (Req 4.1, 9.10)
  - [ ] 10.2 实现 `executeKbQuery(args): Promise<QueryResult & { durationMs; requestId }>`：
    - 构造 body bytes → 调用 `signRequest` → `fetch(url, { method, headers, body, signal })` + `AbortController`（`setTimeout(ctrl.abort, timeoutMs)`）
    - 按 design §6.3 的失败分类表映射 `AbortError → timeout`、非 2xx → `http_error (保留 httpStatus)`、`fetch` 抛错 / ECONNREFUSED → `http_error`、`res.json()` 抛错 / `validateEvidenceBundle` 失败 → `schema_error`、`signRequest` 抛错 → `signature_error`
    - 所有分支 **不重试**、**不阻塞 turn**，返回值包含 `durationMs` 与 `requestId`
      (Req 4.1, 4.2, 4.3, 4.4, 6.1, 6.2, 6.3, 6.4, 6.6, 6.7)
  - [ ] 10.3 `finally` 中 `clearTimeout(timer)`，确保不泄漏 timer；`fetch` 成功后对返回 JSON 走 `validateEvidenceBundle` 再决定 success/schema_error (Req 4.2, 4.3)
  - [ ] 10.4 导出 `QueryOutcome` / `QueryResult` 类型 + `executeKbQuery` + `stableStringify`，保证 dispatcher 与 telemetry 类型一致 (Req 4.5, 8.1)
  - [ ]\* 10.5 `src/__tests__/query-client.test.ts`：以 `vi.fn()` 打桩 `global.fetch` 配合 Node 22+ 原生 `Response`，fast-check 覆盖
    - **P6（schema 往返 + 变异 reject）** (P6, Req 4.2, 4.3)
    - **P12（非 2xx → `http_error`）** 遍历 status ∈ `[100..599] \ [200..299]` (P12, Req 4.3, 6.2, 9.7)
    - **P15（mock 服务端独立重算 HMAC 并比对）**：mock `fetch` 读取 headers 与 body 后用 Node 原生 `crypto` 重算 HMAC 并与 `X-KB-Signature` 比对一致，且时间戳容差 5min 内 (P15, Req 9.10, 3.3)
    - example：AbortController 超时 → `timeout`；`fetch` 抛 `TypeError: fetch failed` → `http_error`；`createHmac` 抛错（注入式 mock）→ `signature_error`（Req 4.4, 6.1, 6.4, 6.6）

  **Verification:** `pnpm test extensions/knowledge-bridge -- --run query-client`
  **Requirements:** 3.3, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 6.1, 6.2, 6.3, 6.4, 6.6, 6.7, 9.10
  **Properties:** P6, P12, P15

- [ ] 11. Dispatcher `src/dispatcher.ts`
  - [ ] 11.1 实现 `dispatchMessageReceived(event, ctx, services)`：
    - 调用 `resolveKbConfig(services.api.pluginConfig)`，`cfg.enabled===false` 或解析失败 → return（`disabled` 分支记录一次 `KB_QUERY_EVENT { outcome:"disabled" }`） (Req 1.5, 7.2)
    - 依次 guard：`isInboundSynthetic`、`isNonTextInbound`、`perChannel[channelType] === false`，命中任一则 skip 且不发 HTTP、不写 cache (Req 2.9, 2.10)
    - 调用 `services.credentials.get(cfg.sharedSecretRef)`，失败 → 写 cache `{outcome:"config_missing"}` 并 emit telemetry，不发 HTTP (Req 3.7, 6.5)
    - 调用 `executeKbQuery(...)`，将 `QueryResult` 写入 `TurnCache` keyed by `cacheKey(ctx)` 并调用 `services.telemetry.emitQuery(...)` (Req 4.1–4.6, 6.1–6.7, 8.1)
  - [ ] 11.2 实现 `dispatchBeforePromptBuild(event, ctx, services)`：
    - 每次入口重新 `resolveKbConfig`，`enabled===false` → return undefined (Req 1.5)
    - `cache.takeAndDelete(cacheKey(ctx))`：cache miss → emit `KB_INJECTION_EVENT { injected:false, reason:"cache_miss" }` 后 return undefined (Req 4.5, 5.7, 8.3)
    - `ctx.hooks?.allowPromptInjection === false` → emit `KB_INJECTION_EVENT { injected:false, reason:"prompt_injection_disabled" }` 后 return undefined（即使 outcome 为 success 也不注入） (Req 5.9, 6.10, 8.3)
    - cached.outcome === "success" → 调用 `renderSuccess(bundle, cfg)` 返回 `{prependSystemContext, appendContext}`；否则 → 调用 `renderStatusSegment(outcome)` 返回 `{prependSystemContext}` (Req 5.1, 6.8)
    - 两条路径均 emit `KB_INJECTION_EVENT { injected:true, outcome }` (Req 8.3)
  - [ ] 11.3 定义 `DispatcherServices` 组合类型：`{ config: KBConfig; credentials; cache: TurnCache; telemetry; api; now }`，便于 index.ts 注入 + 测试替身
  - [ ]\* 11.4 dispatcher 的薄单元测试可选；主要断言放在任务 12 的 `index.test.ts`。若添加，覆盖 guard 顺序与 telemetry 事件是否按预期 emit（Req 1.5, 2.9, 2.10, 5.9, 6.10）

  **Verification:** `pnpm test extensions/knowledge-bridge -- --run dispatcher`（若未创建 dispatcher.test.ts 则由 index.test.ts 兜底）
  **Requirements:** 1.5, 2.9, 2.10, 3.7, 4.1, 4.5, 5.1, 5.7, 5.9, 6.5, 6.8, 6.10, 7.2, 8.1, 8.3

- [ ] 12. 插件入口 `index.ts` + 集成测试 `index.test.ts`
  - [ ] 12.1 完善 `index.ts`：在 `definePluginEntry({ ..., register: (api) => { ... } })` 的 `register` 中：
    - 通过 `api.pluginConfig` + `resolveKbConfig` 构造 `services`（cfg、credentials loader、TurnCache、telemetry、now）
    - `api.on("message_received", (event, ctx) => dispatchMessageReceived(event, ctx, services), { priority: 50, timeoutMs: cfg.timeoutMs + 500 })`
    - `api.on("before_prompt_build", (event, ctx) => dispatchBeforePromptBuild(event, ctx, services), { timeoutMs: 2_000 })`
    - register 阶段禁止调用 `fetch` / `api.registerSessionExtension` / `api.enqueueNextTurnInjection`（Req 1.4, 5.7）
  - [ ] 12.2 在 `api.ts` 中 re-export `definePluginEntry` 使用的入口对象与 `KBConfig` 类型（供外部 contract / 测试 import） (Req 10.1)
  - [ ] 12.3 编写 `index.test.ts`，参照 `extensions/active-memory/index.test.ts` 的 `hooks / hookOptions / api` fake 风格，覆盖：
    - register 阶段不触网（`fetch` 未被调用）、未调用 session-extension / next-turn injection 相关 seam (Req 1.4, 5.7)
    - 成功路径：`message_received` → mock fetch 返回合法 Evidence_Bundle → `before_prompt_build` 返回 `{prependSystemContext, appendContext}` 且包含 success 模板锚点 (Req 4.1–4.6, 5.1–5.8)
    - timeout 路径：mock fetch 触发 AbortError → `before_prompt_build` 注入 `Knowledge_Bridge_Status_Segment` 且 `Query_Outcome: timeout` (Req 4.4, 6.4, 6.8, 9.7)
    - config_missing 路径：credentials loader 返回 `{ok:false}` → 未发 fetch、before_prompt_build 注入 status segment 且 `Query_Outcome: config_missing` (Req 3.7, 6.5)
    - `ctx.hooks.allowPromptInjection === false`：before_prompt_build 返回 undefined，但 `fetch` 仍被调用（Req 5.9, 6.10）
    - `perChannel[ch] === false`：不发 fetch、不写 cache、不注入 (Req 2.10)
    - `ctx.isSynthetic === true`：不发 fetch、不写 cache、不注入 (Req 2.9)
  - [ ]\* 12.4 在 `index.test.ts` 中新增 **P14（全路径密钥不泄漏）**：fast-check 生成随机 secret，驱动 success/timeout/http_error/schema_error/signature_error/config_missing 全枚举，捕获 fake `PluginLogger` / telemetry sink 的所有字符串 payload，断言不含 `secret` 的 UTF-8 与 Base64 表达 (P14, Req 3.8, 6.11, 8.2, 9.9)

  **Verification:** `pnpm test extensions/knowledge-bridge -- --run index`
  **Requirements:** 1.4, 2.9, 2.10, 3.7, 3.8, 4.1, 4.4, 4.5, 5.1, 5.7, 5.9, 6.4, 6.5, 6.8, 6.10, 6.11, 8.2, 9.7, 9.9, 10.1
  **Properties:** P14

- [ ] 13. Checkpoint · 质量门执行
  - [ ] 13.1 `pnpm check:changed`（覆盖 extension prod + extension test 两条 lane，按仓库规约在 Testbox 上运行，保持绿）
  - [ ] 13.2 `pnpm test extensions/knowledge-bridge`（单包 vitest 全绿）
  - [ ] 13.3 `pnpm check:architecture`（边界红线：不 import core `src/**` 与其他 extension 的 `src/**`）
  - [ ] 13.4 `pnpm plugin-sdk:api:check`（公共 SDK surface 未漂移）
  - [ ] 13.5 `pnpm exec oxfmt --check --threads=1 extensions/knowledge-bridge`（格式化）
  - [ ] 13.6 `pnpm lint:*` 仓库包装器（oxlint，不得有新告警）
  - [ ] 13.7 `pnpm deps:root-ownership:check`（新增依赖只出现在插件 `package.json`）
  - [ ] 13.8 Checkpoint：全部绿后交付；若有问题回到对应模块任务修复并重跑；整个流程中询问用户以确认设计偏离（若发现）

  **Verification:** 上述七条命令全部绿
  **Requirements:** 10.1, 10.2, 10.3, 10.4

- [ ]\* 14. README 与配置示例 `extensions/knowledge-bridge/README.md`
  - [ ]\* 14.1 撰写 README：描述配置契约、`~/.openclaw/credentials/knowledge-bridge/shared-secret` 的凭据存放位置与权限建议、`/query` 失败的降级行为（Knowledge_Bridge_Status_Segment 注入 + `MANDATORY_USER_NOTICE`）、可观测字段（`KB_QUERY_EVENT` / `KB_INJECTION_EVENT`）、确定性注入的跨 outcome prompt-cache 行为说明（design §16 风险 2） (Req 7.1, 8.1, 8.3, 6.8)
  - [ ]\* 14.2 附最小配置示例 JSON 片段（仅示例 `credentialKey`，禁止包含真实密钥字面量） (Req 3.8, 7.1)

  **Verification:** `pnpm exec oxfmt --check --threads=1 extensions/knowledge-bridge/README.md`
  **Requirements:** 3.8, 6.8, 7.1, 8.1, 8.3

## Notes

- 所有带 `*` 的子任务为可选：负责人可跳过以加速 MVP，但跳过后仍需确保设计中的 Correctness Properties 在后续补测覆盖。顶层任务均为 required，不得跳过。
- Checkpoint（任务 13）在所有实现任务完成后执行；任何门失败回到对应模块任务修复后再次执行。
- Property-Test 全部使用 `fast-check`，`numRuns` 默认 100；`signer` / `injector` 的纯函数 property 可提到 500 次仍不超时。
- 任务编号 1..14 对应 design.md 与 requirements.md 的顺序实现闭环；每条子任务在文本中显式标注 `(Req X.Y)` / `(PN)`，便于审计追溯。
- 本工作流只负责创建规划制品。你可以通过在 tasks.md 中点击 "Start task" 开始执行具体任务。
