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
8. 回复用户：一句话说结果 + 版本号 + 服务端校验是否一致 + 让用户强刷。

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

## 远程仓库：交给赫尔墨斯（2026-10-29 危晓定）

- 本地仓库归我：`git add` / `commit` / 本地 tag / `status` / `log` / `diff`。
- 远程一律交赫尔墨斯（Hermes 侧）：`push` / `fetch` / `pull` / 远端 tag / 远端回滚，不要自己动。
- 原因：dsh 的 Windows 沙箱里 MSYS bash 无法 fork，git 的联网命令在里面起不来；Hermes 侧原生 git 可用。
- 通道（2026-10-29 定稿）：本地推 VPS 裸库 `ssh://tavern/home/ubuntu/git/tavern-ext.git`，VPS 的 post-receive 钩子再走 **SSH 443**（ssh.github.com）推 GitHub。原因：本机到 github.com:443 与 VPS 到 github.com:443 都是间歇性阻断，只有 VPS 到 ssh.github.com:443 实测稳定。
- 远端 sha 与本地一致（真 git push，不是 API 重建），可以正常 fetch / pull。`.deploy/push-via-api.mjs` 只作兜底。
- 凭证不进仓库：VPS 上只有一把专用 ed25519 部署密钥（`~/.ssh/id_ed25519_github`），本机的 GitHub token 放在 `D:\dsh-home\secrets\tavern-ext.env`。

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
