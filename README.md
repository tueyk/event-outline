# tavern-ext — 酒馆前端扩展工作区

给云酒馆（SillyTavern，VPS `/opt/tavern`）写前端扩展的地方。目标是「危晓只提需求和验收，其余由 agent 自主完成」。

## 目录

```
tavern-ext/
├── README.md            本文件：约定与流程
├── .gitignore
├── .local/              本机私有：参考材料、临时脚本（已忽略，不入库）
├── src/<扩展名>/        每个扩展一个目录，直接对应线上 extensions 目录
│   ├── manifest.json
│   └── index.js
├── scripts/             部署与校验脚本（本机执行）
└── docs/                需求、设计、决策记录、踩坑
```

`.local/` 放「有用但不该进仓库」的东西：参考的打包代码、临时脚本、探针输出。目录内另有 README 说明每样东西从哪来、怎么重新提取。`.deploy/` 已废弃，历史临时件都在 `.local/tmp/`。

## 文档索引

每份文档只回答一类问题，别混着写：

| 文档 | 回答什么 | 维护时机 | 状态 |
|---|---|---|---|
| `docs/需求-事件大纲扩展.md` | 要什么、为什么、怎么算做完 | 需求或验收标准变化时 | 现行 |
| `docs/设计-事件大纲扩展.md` | 怎么做、技术细节、数据结构 | 实现方案或技术结论变化时 | 现行 |
| `docs/决策记录-事件大纲扩展.md` | 定过什么、推翻过什么、为什么 | 每次讨论有结论或纠正时 | 现行 |
| `docs/设计-记忆读取-shujuku纪要.md` | shujuku 纪要怎么读、四种模式怎么适配 | 记忆适配方案变化时 | 现行 |
| `docs/需求-OOC词自动化扩展.md` | 最早的讨论稿 | 不再维护 | **已归档**，看终稿 |
| `docs/agent-runbook.md` | 一次改动的标准流程、沙箱限制 | 流程变化时 | 现行 |
| `docs/context-handoff-*.md` | 跨会话交接 | 交接时 | 历史 |

**读的顺序**：需求 → 设计 → 决策记录。决策记录里 §2「被实测推翻的判断」是最该先看的部分，那里每一条都是走过弯路换来的。

当前扩展：

- `event-outline`（事件大纲）→ 需求 / 设计 / 决策记录 / 记忆读取 四份都在 docs 下

## 版本规则

- 每个扩展独立版本，唯一真源是 `src/<扩展名>/manifest.json` 里的 `version`。
- 语义化：修 bug 升 patch，加功能升 minor，改数据结构升 major。
- git tag 格式 `v<扩展名>-<版本>`，例如 `v-event-outline-0.1.0`，tag 与 manifest 必须完全一致。
- 线上装的到底是哪一版，用 `bash scripts/deploy.sh <扩展名>` 输出的 sha256 比对，不靠记忆。

## 部署

```bash
# 前置：ssh tavern 可用（密钥已配）
bash scripts/deploy.sh <扩展名>
```

流程：tar 打包 → scp 到 VPS → 解到 `/opt/tavern/extensions/<扩展名>/` → `chown -R 1000:1000` → 回读 sha256 比对。
前端扩展不需要重启容器，`Ctrl+Shift+R` 强刷即可。manifest 能被公网取到（HTTP 200）即为服务端已识别。

## 测试

```bash
node scripts/test-event-outline.js   # 世界书写入防护，24 项
node scripts/test-parser.js          # YAML/JSON 解析，28 项
```

两个脚本都从 `src/<扩展名>/index.js` 里正则抽出待测函数，在 `new Function` 沙箱里跑，不依赖浏览器。
改动世界书写入或解析逻辑后**先跑测试再部署**——这两块出错的代价是丢数据或功能全废，靠肉眼看不出来。

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
