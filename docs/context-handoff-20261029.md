# 上下文交接 — 2026-10-29

给在 `tavern-ext` 工作区新开的会话读的。上一轮讨论在「酒馆」工作区的会话 `session-092c1bdc` 里做的，没有迁移，这里把结论搬过来。

## 已经做完的

工作区和 git 仓库已就位（本目录就是仓库根，分支 `main`，两个 commit）：

- `c06dc19` init: 工作区骨架 — README / docs/agent-runbook / scripts/deploy.sh / .gitignore
- `6cf560d` chore: 强制 LF 行尾

`git status` 干净，无未跟踪文件。远端还没建，现在只有本地仓库，没有 origin。

## 用户的授权边界（他明确说过）

原话：「我想全权给你负责，我只负责跟你讨论，需求，测试，效果等等」。

- 自主做：建目录和仓库、写改代码、升 manifest 版本、`node --check`、提交、发 tag、部署到 `/opt/tavern/extensions/<name>`、sha256 校验、写文档、revert 回滚。
- 先报备：删目录或文件、改 `/opt/tavern` 下扩展以外的东西（settings.json / config.yaml / compose / 别的扩展）、重启容器、强推、任何会覆盖本地改动的 pull。
- 永不碰：GitHub 账号密码与 token、SSH 私钥、角色卡、存档、世界书、付款注册授权。
- 凭证不写进回复、文件、日志。

## 还没定的决策

远端仓库用哪种结构，用户还没定。三个选项（本地 `main` 已就绪，只差一个 origin）：

1. VPS 裸库为主库（`/opt/git/tavern-ext.git`，走已有 `ssh tavern` 通路），GitHub 留用户自己当镜像。agent 能全流程自主，推荐。
2. 用户在**本机**配 GitHub 专用密钥，agent 只调 git 命令、不读密钥。
3. 用户给一个只对本仓库、只有 Contents 权限的 fine-grained PAT，经环境变量传。

技术上唯一卡死的是 git push 需要凭证，而 agent 读不到凭证目录。除推送外其余全流程都可自主。

## 酒馆扩展的技术要点（上一轮讨论过的）

- 前端扩展只要两个文件：`manifest.json` + `index.js`，放 `/opt/tavern/extensions/<name>/`，**不需要** `enableServerPlugins`，不需要重启容器，`Ctrl+Shift+R` 生效，删目录即回滚。
- manifest 必填：`js`、`css`（可空）、`display_name`、`loading_order`。
- 代码要点：`window.SillyTavern.getContext()` 后用 800ms 轮询等 `Array.isArray(ctx.chat)`；监听 `MESSAGE_RECEIVED` 与 `CHAT_CHANGED`；读世界书走 `POST /api/worldinfo/get`，headers 必须带 `ctx.getRequestHeaders()`（含 CSRF）；入口按钮左上角带文字、`z-index:999999`；无构建的原生 JS，不能用 `import`。
- 第三方扩展与卡内 MVU / stat_data 抢状态是经典坑，自己写的扩展默认只读，不写回聊天与世界书。

## 和上一个会话的关系

`tavern-ext` 的工作区和 git 仓库是在「酒馆」会话里建的，代码和文档都已经落盘，新会话直接读本目录即可接上。之前关于「怎么给用户写扩展 / 扩展有哪几类 / 安装路径」的完整技术说明在上一个会话里，要细节就回去翻，但结论都收在 `README.md` 和 `docs/agent-runbook.md`。
