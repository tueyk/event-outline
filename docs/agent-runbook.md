# 工作约定（agent 执行手册）

这份文件写给接手的人（就是我自己）。用户只看 README 的结论和每次交付的汇报。

## 一次改动的标准流程

1. 读需求，先把「验收标准」一句话写进 commit 前的工作记录：改了什么行为、怎么算成功。
2. 在 `src/<扩展名>/` 改代码；只改这一个扩展目录。
3. 自查：`node --check index.js`；`manifest.json` 用 `node -e "JSON.parse(...)"` 验一遍。
4. 改 manifest 的 `version`，按语义化升号。
5. `bash scripts/deploy.sh <扩展名>` 部署并回读 sha256。
6. `git add -A && git commit`，message 写清：动了什么、为什么、版本号。
7. 打 tag：`git tag v-<扩展名>-<version>`。
8. 推送：`bash scripts/remote-sync.sh push`（见下文「远程仓库」，不要再交赫尔墨斯）。日志出现 `exit=0` 才算到 GitHub。
9. 回复用户：一句话说结果 + 版本号 + 服务端校验是否一致 + 让用户强刷。

## 提交信息格式

```
<扩展名>: <一句话做了什么> (v1.2.0)

- 具体改动点 1
- 具体改动点 2
原因：<为什么改，用户的哪句话触发的>
```

## 需要先报备

- 删目录、删文件、`git push --force`、`docker restart`
- 改动 `/opt/tavern` 下扩展目录以外的任何东西
- 改动用户已有扩展（Pathweaver 汉化、shujuku、酒馆助手脚本）

## 远程仓库：dsh 侧自己负责（2026-10-30 危晓改定）

- 全部本地与远程操作都由我（dsh）做：`add` / `commit` / `tag` / `push` / `fetch` / `pull` / 远端 tag / 远端回滚。
- **2026-10-30 变更**：原「远程一律交赫尔墨斯」作废。当时那么定，是因为以为 dsh 沙箱做不了远程 git；现经 VPS 中继已验证可行，危晓明确把远程操作收回给 dsh，不再经赫尔墨斯。
- 通道：本地 → VPS 裸库 `ssh://tavern/home/ubuntu/git/tavern-ext.git` → 裸库 `post-receive` 钩子走 **SSH 443**（ssh.github.com）转推 GitHub。
- 原生命令仍然不可用：沙箱禁止 git fork 传输层与打包子进程，`git push|fetch|ls-remote|bundle` 会报 `cannot create standard input pipe ... Permission denied`。**不要再试原生命令**，一律用脚本：

```bash
bash scripts/remote-sync.sh ls-remote      # 比对本地与 VPS 裸库
bash scripts/remote-sync.sh push           # 本地 → VPS → GitHub（自动触发钩子）
bash scripts/remote-sync.sh fetch          # VPS → 本地，不合并
bash scripts/remote-sync.sh pull           # VPS → 本地并快进
bash scripts/remote-sync.sh push-log       # 看转推 GitHub 的日志
```

- 原理：脚本自己当传输层。`rev-list --objects` 落文件 → `pack-objects --stdout` 造 pack → ssh 管道送 VPS → 裸库 `index-pack` 收包 + `update-ref` → 手动调用 `post-receive`。
  因为直接写裸库对象、不走 `receive-pack`，钩子不会自动跑，所以脚本里显式调用一次。
- 推送成功后必须看日志里有 `exit=0` 才算真的到了 GitHub；脚本会自查，失败时以非零退出。
- 远端 sha 与本地一致（真 git 对象，不是 API 重建）。`.deploy/push-via-api.mjs` 只作兜底。
- 凭证不进仓库：VPS 上只有一把专用 ed25519 部署密钥（`~/.ssh/id_ed25519_github`）。本机若存在 GitHub token，放在 DSH_HOME 下的 secrets 目录，不入库（当前中继方案用不到它）。

### 沙箱哪些 git 子命令能跑（2026-10-30 实测）

- 能：`rev-parse` / `log` / `status` / `cat-file` / `rev-list` / `archive` / `add` / `commit` / `pack-objects --stdout`（用文件重定向喂 stdin）/ `index-pack` / `update-ref` / `fetch <本地文件>`。
- 不能：任何要 fork helper 的操作 —— `push` / `fetch` / `ls-remote` 走网络、`git bundle`（内部要 fork `pack-objects` 走管道）。
- 判断方法：报 `cannot create standard input pipe for <x>` 或 `fatal: unable to fork` 就是撞上这条限制。

## 永不触碰

- GitHub 账号密码、token、SSH 私钥
- 角色卡、聊天存档、世界书、settings.json
- 任何付款、注册、授权操作

## 扩展自查清单（发布前）

- [ ] manifest 有 `js` / `css` / `display_name` / `loading_order`
- [ ] `loading_order` 是纯数字
- [ ] `index.js` 里没有 `import`（无构建的原生 JS，浏览器直接加载）
- [ ] 不依赖 `requires` 里没列的扩展
- [ ] 只用 `window.SillyTavern.getContext()`，不在加载时同步读数
- [ ] 事件监听有 `CHAT_CHANGED` 与 `MESSAGE_RECEIVED` 两条
- [ ] 入口按钮带文字、放左上角、`z-index: 999999`
- [ ] 出错时 console 有可读日志，界面不白屏
- [ ] 不写回聊天、世界书、变量（只读扩展的硬约束）
