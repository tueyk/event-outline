# 记忆读取设计 — 怎么读到 shujuku 里的纪要

- 版本：v1（2026-10-30）
- 对应需求：`需求.md` §4.9「记忆来源可配置」
- 前身：`设计.md` §4（v6 的调研结论），本文把它单独落成可实施的方案
- 取舍来龙去脉：`决策记录.md` §2.6–2.8、§3.6

> 本文只回答三件事：**数据存在哪、四种填表模式怎么读、设置里给用户什么选项。**
> 不含代码实施细节，也不改任何 shujuku 文件。

---

## 要查询的问题（先说清楚查了没查到）

你要问的是「扩展能不能读到第三方记忆插件 shujuku 里存的纪要」。拆成三个：

| # | 问题 | 现状 |
|---|---|---|
| A | shujuku 的纪要数据到底存在哪 | **已查清楚**：浏览器内存里的表数据 + 聊天楼层 `TavernDB_ACU_IsolatedData` 的增量日志，不是独立数据库文件 |
| B | 扩展用什么路径读得到 | **读得到**，两条路径：全局变量（首选）/ 回放楼层（兜底）；不用碰 shujuku 的代码 |
| C | 有没有一处结论还悬着 | **有两处**，见下 |

**两处待实测 → 已查清**（2026-10-30 下午补）：

1. ~~`globalThis.currentJsonTableData_ACU` 是否稳定可读~~ —— **不依赖它**。实测 shujuku 只对外挂了 `__currentJsonTableData_ACU`、`ACU_getCrossfireRollingDelta`、`ACU_setCrossfireRollingDelta`、`__templatePresetsStoreForDiagnostics_ACU`、`ACU_SQL_WASM_URL_ACU` 这几个零散全局，没有可直接读当前表的接口。所以走楼层回放 `logEntries`，读数一致，只是每次盘点多一次解析。

2. ~~shujuku 当前填表模式存在哪~~ —— **已查清，两处都不是**。不存在 `window.getCurrentFillMode()`，也不存在 `localStorage['acu_fill_mode']`。真实位置：

```
chat_metadata.TavernDB_ACU_ScopedConfig.fillModeByIsolationKey[隔离码].mode
```

隔离码在未启用数据隔离时为空字符串；每项形如 `{ mode: "llm", recordedAt: 1793069328086 }`。兰开斯特堡存档实测值 `{"":{"mode":"llm","recordedAt":1793069328086}}`。源码依据：`resolveCurrentChatFillMode_ACU` → `readFillModePreferences_ACU` + `peekChatScopedConfigContainer_ACU`，容器字段名常量 `tt="TavernDB_ACU_ScopedConfig"`。

顺带：同容器里还有 `flightModeByIsolationKey`，是另一套东西，不要误读。

---

## 1. 数据存在哪

### 1.1 存储只有两种 provider，和填表模式无关

```js
function createProvider(t) {
  return "sqlite" === t ? new SqlTableService : new NativeTableServiceAdapter
}
```

- `native`（默认）：表数据由 shujuku 自己持在**页面内存和楼层的聊天元数据**里，**没有外部数据库文件**。
- `sqlite`：SQLite **WASM 侧**的 provider，用于在内存中执行 SQL，同样不是磁盘上某个 `.db` 文件；节点上 `find` 不到 `.db` 也正是这个原因。

所以「找 shujuku 的数据库文件然后打开」这条路不存在。要读，只能读它在酒馆里留下的数据。

### 1.2 真正的落盘位置：聊天楼的 `TavernDB_ACU_IsolatedData`

```
聊天存档 .jsonl 的某条消息
└── TavernDB_ACU_IsolatedData
    └── ""                        ← 隔离键（空串 = 未启用隔离码）
        ├── storageFrame          ← version: 2
        │   ├── logEntries[]      ← 增量操作日志（不是快照）
        │   └── headRevision
        └── _acu_storage_version

logEntries[i]:
  { seq, entryId, createdAt, targetMessageIndex, aiFloor,
    filledSheetKeys[], changedSheetKeys[], operations[], ... }
operations[i]:
  kind: "sheet_replace" | "row_upsert"
  sheetKey, sheet.name, sheet.content[][]   ← content[0] 是表头
```

要点：

- **不是快照是日志**。要拿最终态必须按 `seq` 升序回放所有楼层的 `logEntries`。
- `TavernDB_ACU_Data` / `SummaryData` / `IndependentData` 是旧版兼容字段，读取优先级 `IsolatedData → IndependentData → Data → SummaryData`。
- 实测 VPS 四个存档（仲夏夜、兰开斯特堡、石桥镇、异常应对女子高中）**全部只有 `IsolatedData`**。
- 隔离键是**全插件一份的全局设置**（`dataIsolationEnabled && dataIsolationCode || ""`），不是按 chatId 自动分的。兰开斯特堡实测为空串，即未启用。

### 1.3 纪要表长什么样

205 行 = 表头 + 204 条。

```
表头：["row_id","编码索引","时间跨度","概览","纪要","重要对话"]
AM0204 | 1497-01-26 07:05 ~ 07:25
  概览：野法师格雷夫上门点名，二人移步客栈背后谈话（≤30 字）
  纪要：危晓在公会分站板前犹豫五张委托时……（240–480 字）
```

**认表必须按名字 `"纪要表"`，不能按 key**：

```js
Object.values(t).find(t => "纪要表" === t?.name)
```

`sheet_ji_yao_biao` 只是兰开斯特那套拼音模板的 key，换卡换模板就变，但名字不变。写死 key 的后果是**换模板后静默读不到**（表在，但回退成纯楼层，还不报错）。

兰开斯特卷实测 8 张表：纪要表 / 重要角色表 / 选项表 / 任务与事件表 / 被宝物品牌 / 全局数据表 / 主角信息表 / 主角技能表。

### 1.4 对扩展的硬约束（由存储形态推出来）

| 约束 | 原因 |
|---|---|
| 只读，绝不写回 | 楼层里的日志是 shujuku 的账本，写错一层就毁数据 |
| 不能按 key 认表 | 见 1.3 |
| 必须处理隔离键 | 用户切了隔离码，数据挂在别的键下；默认取空串，取不到就降级 |
| 不能靠世界书蓝灯 | 向量/交火模式下 shujuku 会把召回行的中间态导出成 `TavernDB-ACU-CustomExport-` 条目并频繁增删，是临时态；`generateRaw` 本身也不吃世界书 |
| 不能调它的召回函数 | `runPlotTasksRuntime_ACU` 是 IIFE 私有闭包，四种暴露方式全部 0 处 |

---

## 2. 四种填表模式怎么适配

### 2.1 一句话结论

**存储是同一套，读取路径只有一套；模式决定的是「从这 204 条里挑哪些进上下文」，不是「去哪读」。**

所以适配 = 一个适配器 + 四套召回策略，而不是四个适配器。

| 模式 | shujuku 自己怎么挑 | 我们的召回策略 | 召回调用成本 | 上下文形态 |
|---|---|---|---|---|
| `classic` 经典表格 | 固定窗口，最近 N 条（`recentChronicleRows` 1–200） | 同样取最近 N 条（默认 30，可配 5–60） | 0 次 | 纪要正文，按时间正序 |
| `llm` LLM 模型逻辑召回 | LLM 读概览清单，按信息缺口点名精读 | **概览清单全列 → 点名 → 精读被点名条目** | +1 次 `generateRaw` | 概览（AM 码 + 30 字）→ 被点名条目正文 |
| `vector` 向量表格 | embedding + rerank 选行，选中行导出成蓝灯条目 | 概览清单全列（默认上限 60 行）→ 点名 → 精读 | +1 次（点名）；不额外做 embedding | 同 llm |
| `crossfire` 交火 | 关键词 + 向量 + BM25 + rerank + LLM 综合 | 同 vector | +1 次 | 同 llm |
| 模式读不到 | — | 按 `classic` 处理 | 0 次 | 纪要正文 |

三条设计理由：

1. **不能统一降级成固定窗口**。向量模式下只给最近 30 条，等于抹掉这个模式存在的意义（决策记录 §2.8 已经纠正过一次）。
2. **不去复刻它的 embedding/rerank**。我们的召回上下文里有事件卡状态（大纲、已触发/未触发节点、已推翻的误导），比它的通用语义匹配更贴当期事件，「概览点名」这一步就够。真去调它的向量链路，等于把它的依赖和内部实现搬过来。
3. **也不蹭它的蓝灯条目**。技术上能读 `TavernDB-ACU-CustomExport-纪要-<行号>`，但那是它每轮写的中间态，时机不可控；原始纪要表本来就是全量数据。

### 2.2 「模式从哪知道」由扩展内部完成，不进设置

```
detectMode():
  1. 读 chat_metadata.TavernDB_ACU_ScopedConfig.fillModeByIsolationKey[隔离码].mode
       - 优先空隔离码 ''
       - 否则取 recordedAt 最新的一条
  2. 读不到 → 返回 null，面板显示「模式未识别」，召回按固定窗口处理
  3. 模式 → 召回策略（表见 2.1）
```

面板上只读展示一行，例如：

> **当前实际使用：shujuku 纪要（LLM召回模式，204 条可用，本次点名 6 条）**

四种模式的读数必须一致（同一话题问同样的问题，来自纪要的事实不该因为模式不同而不同），差别只在「进了多少」和「多不多一次调用」。

### 2.3 统一读取流程（伪代码）

```
readChronicle():
  sheets =
    if (全局表数据变量可读) → 直接取
    else → 从 ctx.chat 尾部往前逐楼读 TavernDB_ACU_IsolatedData[isolationKey]
            .storageFrame.logEntries，按 seq 升序回放 sheet_replace / row_upsert
            旧字段 IsolatedData 缺失时按 IndependentData → Data → SummaryData 兜底
  sheet = 按 name === "纪要表" 找；找不到再按 key 兜底
  rows  = 解析 content[][]：按表头名索引「编码索引/时间跨度/概览/纪要」，
          不按列序硬取（模板可能换列序）
  return rows  // 按编码升序
```

`row_upsert` 按 `row_id` 更新而不是整表替换，回放时两种 op 都要实现；只要最终态。

---

## 3. 设置里给用户什么选项

原则：**用户只做「用哪个来源」这一个粗决策，其余全部内部自适应、只读展示。**

### 3.1 设置面板（记忆一节）

```
记忆来源
  [ 自动选择（推荐）          ▾ ]
    ├ 自动选择（推荐）    ← 默认
    ├ shujuku 纪要
    ├ 仅最近楼层
    └ （后续：其它记忆扩展）
  ┌──────────────────────────────┐
  │ 当前检测结果                  │
  │ shujuku 纪要 · LLM召回 · 204 条 │
  │ 本次进上下文：概览 60 + 精读 6  │
  └──────────────────────────────┘
  ⓘ 自动选择按优先级探测：shujuku 纪要 → （预留）其它 → 仅最近楼层。

纪要条数
  固定窗口取最近 [ 30 ] 条   （范围 5–60）
  概览清单最多列 [ 60 ] 行   （范围 20–204）

最近楼层
  盘点时附带最近 [ 15 ] 楼原文（范围 5–40）
```

字段（`extension_settings.event_outline.memory`，存服务端 settings.json，三端同步）：

```json
{
  "source": "auto",          // auto | shujuku-jiyao | recent-floors
  "jiyaoRecentRows": 30,     // classic 模式的固定窗口
  "jiyaoOverviewMax": 60,    // llm/vector/crossfire 模式概览清单上限
  "recentFloors": 15
}
```

### 3.2 刻意不给的选项

| 不给 | 原因 |
|---|---|
| 「填表模式」下拉（经典/向量/LLM/交火） | 模式是 shujuku 那边的设置，这边再开一个必然打架：你在 shujuku 选了 LLM 召回，我们却因为这边写着经典给你降级 |
| `smartRecall: auto/always/never` 开关 | 同上，两个开关决定同一件事，出问题无法判断是谁降的级 |
| 「强制点名」/「强制固定窗口」 | 想省钱就直接在 shujuku 里切经典模式，那是唯一的真相源 |
| shujuku 数据写入、改模式、改隔离码 | 越界；只读扩展的硬约束 |

### 3.3 降级与提示规则（不静默失败）

| 情形 | 行为 | 界面 |
|---|---|---|
| 自动选择，探测到 shujuku | 正常使用 | 绿色：模块名 + 模式 + 条数 |
| 自动选择，无任何模块 | 用最近楼层 | 灰色：「未检测到记忆模块，使用最近楼层」 |
| 手动选 shujuku，但当前对话无数据 | **自动降级为最近楼层**，不报错不中断 | 黄色：「已选 shujuku 纪要，但当前对话没有检测到数据」，带「切回自动选择」按钮 |
| 读到了表但解析出 0 行（换模板、列名变了） | 降级 + console 打可读日志（表名、key、表头原文） | 黄色 + 「表结构不认识」 |
| 隔离码非空且对应键下无数据 | 按空串再试一次，仍无则降级 | 黄色 |
| 回放楼层时某楼数据损坏 | 跳过该楼继续，日志记条数 | 仅 console |

**为什么默认自动**：换卡、换存档、换聊天时不用改设置；你现在多数对话没开 shujuku，手动指定会一直停在「探测失败」。

---

## 4. 对现有实现的影响（本次不改代码，只列清单）

当前 `src/event-outline/index.js` 的记忆部分与本文的差距：

| # | 现状 | 偏差 | 动作 |
|---|---|---|---|
| 1 | `collectSheetsFromChat()` 按 `result.set(op.sheetKey, …)` 整表覆盖，未实现 `row_upsert` 按 `row_id` 合并 | 表若是逐行 upsert 的，回放会丢行 | 按 op.kind 分别处理 |
| 2 | 隔离键不区分，任意键都读 | 用户切了隔离码会拿到错的键 | 取当前隔离键，无数据再退空串 |
| 3 | `parseChronicle()` 找不到列名时按列序兜底（1/2/3/4） | 模板换列序时静默取错列 | 只按表头名取，取不到报「表结构不认识」 |
| 4 | 只实现了固定窗口 `rows()`，没有 llm/vector/crossfire 的点名精读，也没有 `jiyaoOverviewMax` | 与需求 §4.9「四种模式全部支持」不符 | 按 §2.1 补四套召回策略 |
| 5 | ~~`detectShujukuMode()` 读 `getCurrentFillMode` / `localStorage['acu_fill_mode']`~~ | **已修**，改读 `chat_metadata.TavernDB_ACU_ScopedConfig.fillModeByIsolationKey`，实测可读到 `llm` | 已改 |
| 6 | 全局读取只用楼层回放，未用全局表数据变量 | 每次盘点多一次全聊解析，大存档慢 | 不修：全局变量无可用接口，回放是唯一可靠路径 |

这些都是实现层的事，**不改变本文的数据位置结论和设置形态**。

---

## 5. 验收对照

| 验收项（来自需求 §7） | 本文哪节保证 |
|---|---|
| 盘点时能引用到 shujuku 纪要内容 | §2.3 读取流程 |
| 四种填表模式都能读，读数一致 | §2.1 同一套存储、同一套解析 |
| 模式判断全在内部，设置里只有「记忆来源」 | §2.2 + §3.2 |
| 纪要表按名字「纪要表」识别，换模板仍能找到 | §1.3 |
| 经典/向量/交火模式下盘点不产生额外 LLM 调用 | §2.1 成本列 |
| 默认自动选择，面板显示实际模块与条数 | §3.1 + §3.3 |
| 手动指定无数据时黄提示降级，不报错 | §3.3 |
| 没装记忆模块也能盘点 | §3.3 仅最近楼层 |

---

## 6. 风险与回滚

- **只读**：本设计不写 shujuku 任何字段、不改其模式、不碰世界书导出条目，所以没有数据回滚问题。
- 唯一耦合点是「shujuku 升级后全局变量名或模式存放位置变化」→ 表现是退化到楼层回放或 classic 策略，**数据不会错，只是召回变粗**，面板会显示出来。
- 世界书写后校验仍按 v6 规则：只比对非 `▸事件｜` 条目的内容哈希，不看条目总数（shujuku 会动态增删自己的导出条目）。
