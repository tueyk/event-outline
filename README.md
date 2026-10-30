# tavern-ext — 酒馆前端扩展工作区

给云酒馆（SillyTavern，VPS `/opt/tavern`）写前端扩展的地方。目标是「危晓只提需求和验收，其余由 agent 自主完成」。

## 目录

```
tavern-ext/
├── README.md            本文件：约定与流程
├── .gitignore
├── src/<扩展名>/        每个扩展一个目录，直接对应线上 extensions 目录
│   ├── manifest.json
│   └── index.js
├── scripts/             部署与校验脚本（本机执行）
└── docs/                需求、设计、决策记录、踩坑
```

## 文档索引

每份文档只回答一类问题，别混着写：

| 文档 | 回答什么 | 维护时机 |
|---|---|---|
| `docs/需求-<扩展>.md` | 要什么、为什么、怎么算做完 | 需求或验收标准变化时 |
| `docs/设计-<扩展>.md` | 怎么做、技术细节、数据结构 | 实现方案或技术结论变化时 |
| `docs/决策记录-<扩展>.md` | 定过什么、推翻过什么、为什么 | 每次讨论有结论或纠正时 |
| `docs/agent-runbook.md` | 一次改动的标准流程、沙箱限制 | 流程变化时 |
| `docs/context-handoff-*.md` | 跨会话交接 | 交接时 |

当前扩展：

- `event-outline`（事件大纲）→ 需求 / 设计 / 决策记录三份都在 docs 下

## 版本规则

- 每个扩展独立版本，唯一真源是 `src/<扩展名>/manifest.json` 里的 `version`。
- 语义化：修 bug 升 patch，加功能升 minor，改数据结构升 major。
- git tag 格式 `v<扩展名>-<版本>`，例如 `v-scemap-1.2.0`，tag 与 manifest 必须完全一致。
- 线上装的到底是哪一版，用 `scripts/verify.sh` 比 sha256，不靠记忆。

## 部署

```bash
# 前置：ssh tavern 可用（密钥已配）
bash scripts/deploy.sh <扩展名>
```

流程：tar 打包 → scp 到 VPS → 解到 `/opt/tavern/extensions/<扩展名>/` → `chown -R 1000:1000` → 回读 sha256 比对。
前端扩展不需要重启容器，`Ctrl+Shift+R` 强刷即可。manifest 能被公网取到（HTTP 200）即为服务端已识别。

## 回滚

```bash
git revert <commit>          # 代码回滚
bash scripts/deploy.sh <扩展名>   # 重新部署
```

扩展面板里关掉，或删 `/opt/tavern/extensions/<扩展名>` 后刷新，是最快的临时止血手段，无可回滚的数据副作用。

## 远程同步

```bash
bash scripts/remote-sync.sh push     # 本地 → VPS 裸库 → GitHub
bash scripts/remote-sync.sh pull     # VPS → 本地
bash scripts/remote-sync.sh ls-remote
```

原生 `git push/fetch` 在本机沙箱里跑不了（禁止 fork 传输层），走这个脚本。细节见 `docs/agent-runbook.md`。

## 边界

- 只动 `/opt/tavern/extensions/<扩展名>/`，不动 settings.json、config.yaml、compose、别的扩展、角色卡、存档、世界书。
- 删除目录、重启容器、强推、改扩展以外的文件：先报备再做。
- 凭证（GitHub token / 密码 / 密钥）不进本仓库、不进回复、不进日志。
