# Plan: Tape-First Context Autonomy (Phase C Native)

> 本文档是 **目标态设计**，不是兼容迁移文档。
> 核心约束：runtime state 必须从 tape 回放重建，不依赖预制 memory/snapshot。
> 不为旧的 memory/snapshot 保留兼容路径。

---

## A. 进度快照（2026-02-19）

- ✅ Step 4（删除 Memory Extension）已完成：memory handler 与 `.orchestrator/memory` 注入链路已下线。
- ✅ Step 5（删除 Snapshot 路径）已完成：
  - `SessionSnapshotStore` 已删除。
  - runtime `persist/restore/clear session snapshot` API 已删除。
  - `resumeHintsBySession` 与 `ResumeHint` 注入链路已删除。
  - CLI 启动/退出不再调用 snapshot restore/persist。
- ✅ Step 6（第一阶段）已完成：
  - fail-closed gate 以 `SessionManager.contextUsage` 为准，且支持“最近 N turns 内 compact”窗口。
  - gate 可从 tape 的 `context_compacted` 事件回填最近 compact 状态。
  - `contextBudget.compactionCircuitBreaker` 配置面已移除（类型/schema/default/normalize/文档/测试同步）。
- ✅ Step 6（第二阶段）已完成：
  - gate 触发时统一注入 `[TapeStatus]` 状态块（含 `context_pressure`、recent compact 状态、required action）。
  - 新增 `critical_without_compact` 事件，补齐 fail-closed 的观测信号。
- ✅ Step 7（in-memory maps 去 primary 化）已完成：
  - 删除 `taskStateBySession` / `truthStateBySession` 增量 fold 主路径。
  - 引入 per-session replay cache，`getTaskState/getTruthState` 全量切到 replay view 读取。
  - `recordEvent` 改为纯 replay cache 失效，不再增量写入 state map。
  - `TaskLedgerSnapshotStore` 与 `flushPendingTaskSnapshots` 路径已删除，replay 仅依赖 tape（checkpoint + delta）。
- ✅ Step 1（TurnReplayEngine 抽离）第一阶段已完成：
  - 新增独立 `TurnReplayEngine` 模块，承接 replay/build/cache/invalidate 职责。
  - `runtime.ts` 改为组合 engine，不再内嵌 replay 细节实现。
  - 新增 replay 引擎一致性测试与缓存失效测试。
- ✅ Step 2（Anchor/Checkpoint 正式化）第一阶段已完成：
  - 新增 tape 事件契约：`anchor` / `checkpoint`（`roaster.tape.*` schema）。
  - `TurnReplayEngine` 支持从最近 `checkpoint` 起点回放 delta，避免重复 fold 历史段。
  - runtime 新增按 `tape.checkpointIntervalEntries` 自动写 checkpoint 策略。
- ✅ Step 3（第一阶段）已完成：
  - 新增并注册 `tape_handoff` / `tape_info` / `tape_search` 工具。
  - runtime 新增 Tape API：`recordTapeHandoff`、`getTapeStatus`、`searchTape`。
  - `TapeStatus` 注入块补齐 `tape_pressure` / `entries_since_anchor` / `entries_since_checkpoint`。
  - 新增 `tape.tapePressureThresholds` 配置（low/medium/high）并完成 normalize/schema/test 同步。
- ✅ Step 3（第二阶段）已完成：
  - `before_agent_start` 追加 system-level `[Roaster Context Contract]`，明确两条管道与工具职责边界。
  - 无论是否有 message 注入，system prompt 均带 contract，避免 agent 漏读治理规则。

---

## 0. 本质选择（最终定稿）

本方案采用 **选项 A：Tape-First 只覆盖 State 层**，不采用全栈 Tape。

### 0.1 选项 A（采纳）

- State 重建：由 tape fold 驱动，替代 in-memory state maps。
- State 持久化：由 tape append-only 取代 snapshot store。
- Memory 注入：由每轮 replay 产物生成，不依赖 `.orchestrator/memory` 预制文件。
- LLM message 压缩：保留 `ctx.compact()` 能力，但调用入口改为 agent 工具 `session_compact`。
- Fail-closed gate：依据 `SessionManager.contextUsage`（实际 token 压力），不是 anchor 距离。

### 0.2 选项 B（不采纳）

- 不重写/绕过 `pi-coding-agent` 的 SessionManager message 层。
- 不把完整 LLM message 历史迁入 roaster tape。
- 原因：当前架构中 message 层与 state 层职责分离，强行全栈 Tape 会引入高成本重构且不提升本阶段关键目标。

### 0.3 边界结论

- `tape_handoff`：语义阶段切换（state 管理），不负责 token 压缩。
- `session_compact`：对话历史压缩（message 管理），不负责阶段切换。
- 两条管道独立协作，禁止职责混用。

---

## 1. 根本前提：两条管道，两个问题

在 pi-roaster 的架构中，存在**两条正交的管道**，各自独立运作：

```text
┌──────────────────────────────────────────────────────────────────────────┐
│                          pi-coding-agent                               │
│  SessionManager 拥有 LLM message buffer (user/assistant/tool messages) │
│  ctx.compact() 是唯一能缩小这个 buffer 的操作                            │
│  这里发生 token overflow                                                │
├──────────────────────────────────────────────────────────────────────────┤
│                           pi-roaster                                   │
│  RoasterEventStore 拥有 runtime state tape (task/truth/cost/verify)    │
│  这里发生 state 重建                                                    │
│  通过 ContextInjection 把 state 注入到上层 message buffer               │
└──────────────────────────────────────────────────────────────────────────┘
```

| 维度 | State Tape (pi-roaster) | Message Buffer (pi-coding-agent) |
|------|------------------------|----------------------------------|
| 管什么 | task / truth / verification / cost 等运行时状态 | LLM 对话历史 (user/assistant/tool messages) |
| 谁拥有 | `RoasterEventStore` (JSONL) | `SessionManager` (内存 + SDK) |
| 什么会爆 | 不会 — 磁盘文件，fold 很快 | **会爆** — 这是实际的 LLM context window |
| 怎么缩 | `anchor` slice → fold delta | `ctx.compact()` 让 SDK 压缩 messages |
| 对 LLM 可见性 | 间接 — 经 ContextInjection 变为文本 block 注入 | 直接 — 就是 prompt 本身 |

**这意味着：**

- `tape_handoff` 写的是 **state anchor**，它不会减少一个 token 的 LLM 对话历史。
- `ctx.compact()` 压缩的是 **LLM messages**，它和 state tape 无关。
- 删掉 `ctx.compact()` = 拆掉唯一能缩小 LLM context window 的机制 → 系统必然 token overflow。
- 用 "anchor 是否存在" 来 gate → 判断依据错误：agent 做了 handoff 但 messages 照样爆。

**因此，本方案的架构选择是：State 层 tape-first + Message 层 agent-initiated compaction。**
两条管道各司其职，不混淆。

---

## 2. 目标与硬约束

### 2.1 北极星

Agent 在每次调用时从 state tape 回放得到工作记忆，并自主决定：
- 何时 `tape_handoff` 切阶段（state 管理）
- 何时 `session_compact` 压缩对话（message 管理）

框架不再"偷偷替 Agent 管理"这两件事。

### 2.2 硬约束

1. **State Single Source of Truth**：运行态可恢复状态只能来自 session tape（`RoasterEventStore`），不来自 in-memory Maps 或 JSON snapshot 文件。
2. **No Prebuilt Memory Injection**：删除 session/user memory 文件注入链路（`.orchestrator/memory/`、`user-preferences.json`、`roaster-memory-injection`）。
3. **No Runtime Auto Compaction**：runtime 不再自动触发 `ctx.compact()`。改为 agent 通过 `session_compact` 工具主动触发。
4. **Fail-Closed on Message Pressure**：当 `SessionManager` 报告 context usage 达到 critical 且 agent 未调用 `session_compact`，阻断本轮继续执行。Gate 依据是 **message buffer 的实际 token 数**，不是 state anchor 距离。
5. **One-Way Migration**：不做双轨运行，不保留旧 snapshot 恢复。

### 2.3 非目标

1. 不接管 pi-coding-agent 的 message 存储（不把对话历史存入 state tape）。
2. 不保证历史 snapshot 与新 tape 状态互相导入。
3. 不保证旧配置项（`interruptRecovery.sessionHandoff.*`）继续生效。

---

## 3. 目标架构

```text
┌───────────────────────────────────────────────────────────────┐
│                       Agent (LLM)                            │
│                                                              │
│  State 管理:    tape_handoff / tape_info / tape_search       │
│  Message 管理:  session_compact                              │
│                                                              │
│  Agent 自主决定何时切阶段、何时压缩对话                         │
├───────────────────────────────────────────────────────────────┤
│               Context Contract + TapeStatus                  │
│  两套独立信号:                                                │
│  • tape_pressure: state tape 的 anchor 距离/条目数            │
│  • context_pressure: LLM message buffer 的 token 使用率      │
│  明确规则: 哪个压力触发哪个动作                                │
├───────────────────────────────────────────────────────────────┤
│             TurnReplayEngine (per-turn replay)                │
│  read tape → replay(checkpoint + delta) → TurnStateView      │
├───────────────────────────────────────────────────────────────┤
│              Session Tape Store (append-only)                 │
│  event / anchor / checkpoint                                 │
│  (不含 LLM messages — 那是 SessionManager 的事)              │
└───────────────────────────────────────────────────────────────┘
```

---

## 4. Tape 数据模型（统一事件总线）

### 4.1 Entry Envelope

```typescript
interface TapeEntry {
  id: string;
  sessionId: string;
  ts: number;
  turn?: number;
  kind: string;
  payload?: Record<string, unknown>;
}
```

### 4.2 Kind 划分

1. `task_event` / `truth_event`（已有 fold 语义，保留）
2. `tool_call_marked` / `tool_result_recorded`
3. `verification_*` / `cost_*` / `budget_*` / `parallel_*`
4. `anchor`（语义阶段边界 — agent 创建）
5. `checkpoint`（机器恢复基线 — runtime 创建）
6. `session_*`（start / shutdown / interrupted / compact_performed）

### 4.3 Anchor 与 Checkpoint 的边界

| | Anchor | Checkpoint |
|---|---|---|
| **创建者** | Agent（通过 `tape_handoff`） | Runtime（基于策略自动） |
| **承载** | 语义信息：name、summary、nextSteps | 机器基线：fold 到此刻的 state 快照 |
| **用途** | 阶段切换、tape_search 的检索边界 | 加速 replay（从 checkpoint 开始 fold delta） |
| **对 LLM 可见** | 是（注入 TapeStatus） | 否（纯内部优化） |

不在 `anchor` 里保存 `preservedState`，避免双真相。

---

## 5. 每轮执行流水线（唯一合法路径）

每个 `before_agent_start` 执行：

```text
1. READ        读取当前 session tape entries
2. REPLAY      找最近 checkpoint → fold delta → TurnStateView
3. STATUS      计算两套压力信号:
               ├── tape_pressure:    基于 entries_since_anchor, total_entries
               └── context_pressure: 基于 SessionManager.contextUsage (实际 token 数)
4. BUILD       拼装注入块 (task/truth/ledger digest/tape status/context status)
5. GATE        若 context_pressure == critical 且 agent 未执行 session_compact → 阻断
               (注意: 基于 message token 实际值, 不是 state anchor 距离)
6. CALL        执行 LLM
7. WRITE       追加 turn/tool/result/event/anchor/checkpoint
```

> 规则：本轮只允许一次 replay 产出 `TurnStateView`，后续逻辑全部消费该 view。

---

## 6. Agent 自治契约（Context Contract）

runtime 注入明确契约，区分两种压力、两种动作：

```xml
<context_contract>
## 你管理两个独立的资源

### 1. State Tape（工作记忆）
你的任务状态、验证结果、truth facts 存储在 append-only tape 中。
每次调用时从 tape 回放重建。

信号：[TapeStatus] block 中的 tape_pressure
动作：tape_handoff(name, summary, next_steps)

规则：
- 阶段切换时 SHOULD 调用 tape_handoff
- tape_pressure >= high 时 SHOULD 在完成当前步骤后 tape_handoff
- tape_handoff 不会减少对话长度，只会优化状态重建效率

### 2. Message Buffer（对话窗口）
你的对话历史（user/assistant/tool messages）占用 LLM context window。
这是会实际 overflow 的资源。

信号：[TapeStatus] block 中的 context_pressure
动作：session_compact(reason)

规则：
- context_pressure >= high 时 MUST 在完成当前步骤后 session_compact
- context_pressure == critical 时 MUST 立即 session_compact
  否则下一轮将被 runtime 阻断
- session_compact 会压缩对话历史，不影响 state tape

### 3. 两者独立
- tape_handoff 管阶段切换，不缩对话
- session_compact 管对话压缩，不切阶段
- 可以同时需要两者（阶段切换 + 对话太长）
- 也可以只需要其中一个
</context_contract>
```

### 6.1 Handoff 内容规范

```yaml
tape_handoff:
  name: "investigation-done"   # 阶段标识
  summary:                      # 结构化，不要叙述体
    completed_items: [...]
    in_progress: [...]
    blockers: [...]
    key_findings: [...]
  next_steps: "..."             # 下一阶段应做什么
```

---

## 7. Runtime 安全策略

### 7.1 Fail-Closed Gate（唯一兜底）

```typescript
// Gate 逻辑 — 在 before_agent_start 的 GATE 阶段执行
function shouldBlockTurn(input: {
  contextUsage: ContextBudgetUsage;    // 来自 SessionManager
  recentCompactPerformed: boolean;      // 最近 N turns 内是否执行过 session_compact
}): { blocked: boolean; reason?: string } {
  const pressure = computeContextPressure(input.contextUsage);

  if (pressure !== "critical") {
    return { blocked: false };
  }

  if (input.recentCompactPerformed) {
    return { blocked: false };  // agent 已经尝试压缩了
  }

  return {
    blocked: true,
    reason: "context_pressure_critical_without_compact",
  };
}
```

Gate 依据是 **SessionManager 的实际 context usage**（token 数/比例），不是 state tape 的 anchor 距离。

### 7.2 允许的兜底

1. 记录 `critical_without_compact` 事件到 tape。
2. 阻断本轮（返回错误信息给用户，要求 agent 先 compact）。
3. 当 tape entries 超过阈值时自动写 checkpoint（加速后续 replay，不影响行为）。

### 7.3 禁止的兜底

1. runtime 自动调用 `ctx.compact()`。
2. runtime 自动生成 handoff summary。
3. runtime 从 session/user memory 文件补充上下文。
4. runtime 自动创建 system anchor（避免双真相）。

---

## 8. 工具面设计

### 8.1 State 管理工具

```typescript
tape_handoff = {
  name: "tape_handoff",
  description: "创建阶段边界。在阶段转换或 tape_pressure 高时使用。不缩对话窗口。",
  parameters: {
    name:       { type: "string", description: "阶段名 (如 'investigation-done')" },
    summary:    { type: "string", description: "结构化阶段总结" },
    next_steps: { type: "string", description: "下一步行动建议" },
  },
  // 写 anchor entry 到 tape, 不触发 ctx.compact()
};

tape_info = {
  name: "tape_info",
  description: "查看当前 tape 状态和两套压力指标。",
  // 输出: tape_pressure, context_pressure, entries_since_anchor, last_anchor, ...
};

tape_search = {
  name: "tape_search",
  description: "在历史 tape 中搜索信息。回忆过去阶段细节时使用。",
  parameters: {
    query: { type: "string" },
    scope: { type: "string", enum: ["current_phase", "all_phases", "anchors_only"] },
  },
};
```

### 8.2 Message 管理工具

```typescript
session_compact = {
  name: "session_compact",
  description: "压缩 LLM 对话历史。在 context_pressure 高时使用。不影响 state tape。",
  parameters: {
    reason: { type: "string", description: "为什么要压缩 (如 'context_pressure_high')" },
  },
  execute: async (args, ctx) => {
    // 1. 调用 ctx.compact() — 触发 pi-coding-agent 的 message 压缩
    // 2. 记录 compact_performed event 到 state tape（可审计）
    // 3. 返回压缩前后的 token 数对比
  },
};
```

### 8.3 设计原则

| | `tape_handoff` | `session_compact` |
|---|---|---|
| 管什么 | State tape 阶段边界 | LLM message buffer |
| 写到哪 | Tape anchor entry | 触发 SDK compact + tape event 记录 |
| 减少 token 吗 | **否** | **是** |
| Agent 何时用 | 阶段切换 / tape_pressure 高 | context_pressure 高 |

---

## 9. 状态回放规格（TurnStateView）

每轮回放至少重建以下域：

```typescript
interface TurnStateView {
  // -- 从 tape entries fold 重建 --
  taskState: TaskState;            // foldTaskLedgerEvents()
  truthState: TruthState;          // foldTruthLedgerEvents()
  costSummary: SessionCostSummary; // cost_* events fold
  verification: VerificationSessionState;
  parallel: ParallelSessionSnapshot;
  activeSkill?: string;
  toolCalls: number;
  turnCounter: number;

  // -- 两套独立压力信号 --
  tapeStatus: {
    totalEntries: number;
    entriesSinceAnchor: number;
    lastAnchor?: { name: string; ts: number };
    tapePressure: "none" | "low" | "medium" | "high";  // 基于 entries 数量
  };
  contextStatus: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
    contextPressure: "none" | "low" | "medium" | "high" | "critical";  // 基于实际 token 数
    recentCompactPerformed: boolean;
  };
}
```

`tapePressure` 和 `contextPressure` 是独立计算、独立触发不同动作的信号。

---

## 10. 需要删除/下线的能力（硬删除清单）

### 10.1 Runtime

| 删除项 | 原因 |
|--------|------|
| `SessionSnapshotStore` + `persistSessionSnapshot` / `restoreStartupSession` / `restoreSessionSnapshot` | state 恢复由 tape replay 取代 |
| `resumeHintsBySession` Map + 注入链 | resume 信息从 tape 最近 anchor 的 summary 获取 |
| `latestCompactionSummaryBySession` Map | compaction 事件记录在 tape 中，不缓存 |
| `taskStateBySession` / `truthStateBySession` 等 ~8 个 state Maps | 每轮从 tape fold 重建 |
| `lastInjectedContextFingerprintBySession` | 改为 TurnReplayEngine 内部的 per-turn 去重 |

### 10.2 Extensions

| 删除项 | 原因 |
|--------|------|
| `registerMemory` 整体 | session/user memory 文件注入链路全部下线 |
| `memory/` 子目录 | handoff-builder, hierarchy, relevance, text 等辅助模块 |
| `context-transform` 中 runtime **自动** `ctx.compact()` 逻辑 | 改为 agent 通过 `session_compact` 工具主动触发 |

> **注意**：`ctx.compact()` 的能力本身保留（它是 pi-coding-agent 提供的 SDK 接口）。
> 只是调用入口从 "runtime 自动 turn_end/agent_end 触发" 改为 "agent 通过 session_compact 工具主动调用"。

### 10.3 CLI

| 删除项 | 原因 |
|--------|------|
| 启动时 `runtime.restoreStartupSession(sessionId)` | tape replay 取代 |
| 退出/信号时 `persistSessionSnapshot` | tape 本身是持久化的 |

### 10.4 Config

| 处理 | 配置项 |
|------|--------|
| 废弃 | `interruptRecovery.sessionHandoff.*` |
| 废弃 | `interruptRecovery.snapshotsDir` |
| 保留 | `contextBudget.*` — 用于 context_pressure 观测与 gate 阈值 |
| 新增 | `tape.checkpointIntervalEntries` — 每隔多少 entries 自动写 checkpoint |
| 新增 | `tape.tapePressureThresholds` — entries_since_anchor 对应的 pressure 等级 |

---

## 11. 单向实施计划

### Step 1: TurnReplayEngine + TurnStateView

1. 新建 replay engine 模块（建议路径：packages/roaster-runtime/src/tape/replay-engine.ts）。
2. 实现: read events → find checkpoint → fold delta → `TurnStateView`。
3. 利用现有 `foldTaskLedgerEvents` / `foldTruthLedgerEvents`。
4. 新写 fold 函数: cost, verification, parallel, skill/tool counters。
5. `buildContextInjection()` 改为接收 `TurnStateView` 参数，不直接读 Map。
6. **过渡**: Map 作为缓存保留，但 TurnStateView 是 primary source。

验证: `bun test` 全绿。两种路径（Map vs replay）产出一致。

### Step 2: Tape Anchor/Checkpoint 正式化

1. 在 `RoasterEventStore` 中支持 `anchor` / `checkpoint` kind 的写入和查询。
2. `TurnReplayEngine` 支持 checkpoint-based replay。
3. Runtime 策略: 每 N entries 自动写 checkpoint（只写 state，不写语义）。

验证: replay 一致性测试 — 同一 tape 多次 replay 结果 bit-equal。

### Step 3: 接入 Agent 工具
状态（2026-02-19）：4 项全部完成。

1. 注册 `tape_handoff` / `tape_info` / `tape_search` 工具。
2. 注册 `session_compact` 工具 — 内部调用 `ctx.compact()`，记录 event 到 tape。
3. System prompt 注入 Context Contract（区分两套压力、两种动作）。
4. `TapeStatus` 注入包含 `tape_pressure` + `context_pressure` 两套信号。

验证: 集成测试 — agent 调用工具后 tape 正确写入。

### Step 4: 删除 Memory Extension

1. `registerAllHandlers` 不再调用 `registerMemory`。
2. 删除 `memory.ts` + `memory/` 子目录。
3. 清理相关测试依赖。

验证: `bun test` 全绿。无 `.orchestrator/memory` 读写。

### Step 5: 删除 Snapshot 路径

1. 删除 `SessionSnapshotStore` 及 `runtime.ts` 中的 `persist/restore` 方法。
2. CLI 删除 restore/persist 调用。
3. 删除 `resumeHintsBySession` 及相关注入逻辑。
4. 进程重启 = 从 tape JSONL 文件 re-fold state（经 checkpoint 加速）。

验证: `kill -9` 后重启，仅靠 tape 恢复到正确 TurnStateView。

### Step 6: 关闭 Runtime Auto Compaction + Fail-Closed Gate

1. `context-transform.ts` 删除 `agent_end` 中的自动 `ctx.compact()` 调用。
2. 删除 compaction circuit breaker 逻辑（不再需要，因为 runtime 不再主动 compact）。
3. 在 `before_agent_start` 的 GATE 阶段实现 fail-closed:
   - 检查 `SessionManager.contextUsage` (实际 token 数)
   - 若 critical 且最近未 compact → 阻断并返回错误
4. `session_compact` 事件记录到 tape → Gate 可以查到 "最近是否 compact 过"。

验证: fail-closed 测试 — context_pressure=critical + 无 compact → 阻断。

### Step 7: 消除 In-Memory State Maps

1. 删除 `taskStateBySession` / `truthStateBySession` 等 Map。
2. 所有 state 读取走 `TurnReplayEngine.replay()` → `TurnStateView`。
3. 可保留 per-turn 缓存: 同一 turn 内只 replay 一次。

验证: `bun test` + `bun run typecheck` 全绿。无 Map 残留。

---

## 12. 验证计划

### 12.1 Replay 一致性测试（必须）

1. 同一 tape 多次 replay 结果 bit-equal（TurnStateView 字段一致）。
2. `kill -9` 后重启，仅靠 tape 恢复到同一 TurnStateView。
3. checkpoint replay vs full replay 结果一致。

### 12.2 双管道独立性测试（必须）

1. Agent 调用 `tape_handoff` 后: state tape 有新 anchor，LLM message buffer 不变。
2. Agent 调用 `session_compact` 后: LLM message buffer 缩小，state tape 有 compact 事件但 state 不变。
3. 两者同时调用: 各自独立生效。

### 12.3 Fail-Closed Gate 测试（必须）

1. `context_pressure=critical` 且未 compact → runtime 阻断，返回错误。
2. `context_pressure=critical` 但最近已 compact → 放行。
3. `tape_pressure=high` 但 `context_pressure=low` → 不阻断（只建议 handoff）。

### 12.4 回归测试（必须）

1. `bun run typecheck`
2. `bun run typecheck:test`
3. `bun test`
4. 涉及 CLI/exports 改动时 `bun run test:dist`

---

## 13. 上线门槛

| 指标 | 定义 | 目标 |
|------|------|------|
| `critical_block_rate` | Gate 阻断次数 / 总 turn 数 | 持续下降，低于 5% |
| `agent_compact_rate` | Agent 主动 compact 次数 / context_pressure>=high 次数 | >= 0.7 |
| `agent_handoff_rate` | Agent 主动 handoff 次数 / 阶段切换点数 | >= 0.6 |
| `session_completion_rate` | 成功完成 task 的 session 比例 | >= 旧实现基线 |
| `replay_latency_p99` | 单次 TurnStateView replay 延迟 | < 50ms |
| 残留检查 | 无 snapshot/memory 文件读取路径 | 0 |

---

## 14. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| Agent 不调 session_compact | context overflow → gate 阻断 → 任务中断 | fail-closed + 明确错误信息 + 强化 contract prompt |
| Agent 不调 tape_handoff | replay 范围过大 → 注入 block 质量下降 | tape_pressure 提示 + checkpoint 自动写入保底 replay 性能 |
| 两套压力信号让 agent 困惑 | 调用错误的工具 | contract 中用明确的 if-then 规则，不留歧义 |
| replay 成本随 session 增长 | 延迟抖动 | checkpoint 加速 + 单轮一次 replay |
| 删除 memory 后短期体验下降 | 跨 session 信息丢失 | tape_search 提供可见的自助检索手段 |
| 迁移破坏旧测试 | CI 不稳定 | 按硬删除清单同步重写测试基线 |

---

## 15. Definition of Done

1. 运行时状态恢复完全由 tape replay 提供，无 in-memory Map 作为 primary source。
2. 没有 session/user memory 注入路径（`.orchestrator/memory` 不读不写）。
3. 没有 snapshot 恢复路径（`SessionSnapshotStore` 已删除）。
4. runtime 不自动执行 `ctx.compact()` — 只有 agent 通过 `session_compact` 主动触发。
5. Agent 可通过 `tape_handoff` 管理阶段、通过 `session_compact` 管理对话窗口。
6. Fail-closed gate 基于 SessionManager 的实际 context usage，不是 state anchor 距离。
7. 全量测试通过，且新增 replay 一致性、双管道独立性、fail-closed 测试通过。
