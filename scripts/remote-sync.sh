#!/usr/bin/env bash
# 远程 git 操作走 VPS 中继。
#
# 为什么需要它：dsh 的 Windows 沙箱不允许 git fork 传输层与打包子进程
# （git-remote-https / ssh / pack-objects），所以原生
#   git push|fetch|ls-remote|bundle
# 一律报 "cannot create standard input pipe ...: Permission denied"。
# 但 `ssh.exe` 本身能跑，且 `git pack-objects --stdout` / `git index-pack`
# 以「文件重定向」方式调用时能跑（只是不能作为 git 内部管道子进程被 fork）。
#
# 所以这里自己当传输层：手工造 pack 文件 -> 经 ssh 管道送到 VPS 裸库 ->
# VPS 的 post-receive 钩子再走 ssh.github.com:443 转推 GitHub。
#
# 用法:
#   bash scripts/remote-sync.sh ls-remote [分支]   # 比对本地与 VPS 裸库
#   bash scripts/remote-sync.sh push [分支]        # 本地 -> VPS -> GitHub
#   bash scripts/remote-sync.sh fetch [分支]       # VPS -> 本地（不合并）
#   bash scripts/remote-sync.sh pull [分支]        # VPS -> 本地并快进
#   bash scripts/remote-sync.sh log                # VPS 侧最近提交
#   bash scripts/remote-sync.sh push-log           # VPS 转推 GitHub 的记录
#
# 环境变量:
#   TAVERN_SSH   ssh 别名（默认 tavern）
#   RELAY_REPO   VPS 上裸库路径（默认 /home/ubuntu/git/event-outline.git）
set -euo pipefail

SSH_ALIAS="${TAVERN_SSH:-tavern}"
RELAY_REPO="${RELAY_REPO:-/home/ubuntu/git/event-outline.git}"
RELAY_URL="ssh://${SSH_ALIAS}${RELAY_REPO}"
PUSH_LOG=/home/ubuntu/git/event-outline-push.log

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

BRANCH="${2:-}"
if [[ -z "$BRANCH" ]]; then
  BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo main)"
fi

REMOTE="relay"
TMP=""
cleanup() { if [[ -n "$TMP" ]]; then rm -rf "$TMP"; fi; return 0; }
trap cleanup EXIT

die()  { echo "[ERR] $*" >&2; exit 1; }
info() { echo "[..] $*"; }
ok()   { echo "[ok] $*"; }

sshx() { ssh -o ConnectTimeout=15 -o BatchMode=yes "$SSH_ALIAS" "$@"; }
rgit() { sshx "git --git-dir='${RELAY_REPO}' $*"; }

ensure_remote() {
  if ! git remote | grep -qx "$REMOTE"; then
    git remote add "$REMOTE" "$RELAY_URL"
    info "已添加 remote ${REMOTE} -> ${RELAY_URL}"
  fi
}

need_relay() {
  sshx "test -d '${RELAY_REPO}'" 2>/dev/null \
    || die "VPS 上找不到裸库 ${RELAY_REPO}（ssh 别名 ${SSH_ALIAS}）"
}

# 造一个含 refs/heads/<分支> 全部可达对象的 pack。
# 用文件重定向，避免 git 内部 fork 管道子进程。
make_pack() {
  local out="$1" objs="$2"
  git rev-list --objects "refs/heads/${BRANCH}" > "$objs"
  git pack-objects --stdout < "$objs" > "$out" 2>/dev/null
  [[ -s "$out" ]] || die "生成 pack 失败（$out 为空）"
}

cmd="${1:-}"
case "$cmd" in

  ls-remote)
    need_relay
    local_sha="$(git rev-parse --verify --quiet "refs/heads/${BRANCH}" || echo '<无>')"
    relay_sha="$(rgit "rev-parse --verify --quiet 'refs/heads/${BRANCH}'" 2>/dev/null || echo '<无>')"
    echo "分支      : ${BRANCH}"
    echo "本地      : ${local_sha}"
    echo "VPS 裸库  : ${relay_sha}"
    if [[ "$local_sha" == "$relay_sha" ]]; then
      ok "两边一致"
    elif [[ "$relay_sha" == "<无>" ]]; then
      echo "[!] VPS 裸库还没有这个分支"
    else
      ahead="$(git rev-list --count "${relay_sha}..${local_sha}" 2>/dev/null || echo '?')"
      behind="$(git rev-list --count "${local_sha}..${relay_sha}" 2>/dev/null || echo '?')"
      echo "本地领先 ${ahead} 个提交，落后 ${behind} 个提交"
    fi
    ;;

  push)
    need_relay
    ensure_remote
    dirty="$(git status --porcelain --untracked-files=no)"
    if [[ -n "$dirty" ]]; then echo "[!] 有未提交改动，不会被推送:"; echo "$dirty"; fi
    SRC_SHA="$(git rev-parse "refs/heads/${BRANCH}")"
    RELAY_OLD="$(rgit "rev-parse --verify --quiet 'refs/heads/${BRANCH}'" 2>/dev/null || echo '')"
    if [[ "$RELAY_OLD" == "$SRC_SHA" ]]; then
      ok "VPS 裸库已是最新 (${SRC_SHA:0:7})，无需推送"
      exit 0
    fi
    TMP="$(mktemp -d)"
    PACK="${TMP}/x.pack"
    info "本地造 pack ..."
    make_pack "$PACK" "${TMP}/objs.txt"
    info "pack $(wc -c < "$PACK") 字节，上传到 VPS 裸库 ..."
    # 远端：把包直接解进裸库对象库，再更新分支 ref。
    cat "$PACK" | sshx "
      set -e
      cd '${RELAY_REPO}'
      TMPP=\$(mktemp /tmp/incoming-XXXXXX.pack)
      cleanup_x() { [ -n \"\${TMPP:-}\" ] && rm -f \"\$TMPP\" \"\${TMPP%.pack}.idx\" \"\${TMPP%.pack}.rev\"; return 0; }
      trap cleanup_x EXIT
      cat > \"\$TMPP\"
      BASE=\${TMPP%.pack}
      git index-pack \"\$TMPP\" >/dev/null   # 产物: \$BASE.pack(不变) \$BASE.idx \$BASE.rev
      DEST=objects/pack/\$(basename \"\$BASE\").pack
      mv \"\$BASE.pack\" \"\$DEST\"
      mv \"\$BASE.idx\" \"\${DEST%.pack}.idx\"
      rm -f \"\$BASE.rev\"
      git update-ref 'refs/heads/${BRANCH}' '${SRC_SHA}'
      git cat-file -e '${SRC_SHA}^{commit}'
      echo \"relay-ok \$DEST\"
    " || die "上传或接收失败"
    RELAY_SHA="$(rgit "rev-parse 'refs/heads/${BRANCH}'")"
    [[ "$RELAY_SHA" == "$SRC_SHA" ]] || die "VPS 裸库 sha 与本地不一致：本地 ${SRC_SHA} / VPS ${RELAY_SHA}"
    ok "VPS 裸库已更新到 ${RELAY_SHA:0:7}"
    echo
    echo "--- 触发 post-receive 转推 GitHub ---"
    # 我们直接写裸库对象，不走 receive-pack，钩子不会自动跑，需手动调用。
    sshx "'${RELAY_REPO}/hooks/post-receive' </dev/null" 2>&1 | sed 's/^/    /' || true
    echo
    echo "--- VPS 推送日志（post-receive 结果）---"
    sshx "tail -n 8 ${PUSH_LOG} 2>/dev/null || echo '(无日志)'"
    if sshx "tail -n 1 ${PUSH_LOG} 2>/dev/null | grep -q 'exit=0'"; then
      ok "GitHub 转推成功"
    else
      echo "[!] GitHub 转推可能失败，请核对上面日志（可再跑 push-log 复查）"
      exit 1
    fi
    ;;

  fetch)
    need_relay
    ensure_remote
    RELAY_SHA="$(rgit "rev-parse --verify --quiet 'refs/heads/${BRANCH}'" 2>/dev/null || echo '')"
    [[ -n "$RELAY_SHA" ]] || die "VPS 裸库没有分支 ${BRANCH}"
    if git rev-parse --verify --quiet "refs/remotes/${REMOTE}/${BRANCH}" >/dev/null \
       && [[ "$(git rev-parse "refs/remotes/${REMOTE}/${BRANCH}")" == "$RELAY_SHA" ]]; then
      ok "${REMOTE}/${BRANCH} 已是最新 (${RELAY_SHA:0:7})"
      exit 0
    fi
    TMP="$(mktemp -d)"
    PACK="${TMP}/in.pack"
    info "从 VPS 取包 ..."
    rgit "rev-list --objects 'refs/heads/${BRANCH}'" > "${TMP}/objs.txt"
    # pack-objects 从 stdin 读对象列表，不能再传 ref 参数
    rgit "pack-objects --stdout" < "${TMP}/objs.txt" > "$PACK" 2>"${TMP}/err.txt" || true
    [[ -s "$PACK" ]] || { cat "${TMP}/err.txt" >&2; die "VPS 侧生成 pack 失败"; }
    # 落地到本地对象库并校验
    git index-pack --stdin --fix-thin < "$PACK" >/dev/null 2>&1 || die "本地接收 pack 失败"
    git update-ref "refs/remotes/${REMOTE}/${BRANCH}" "$RELAY_SHA"
    ok "${REMOTE}/${BRANCH} = ${RELAY_SHA:0:7}"
    ahead="$(git rev-list --count "${REMOTE}/${BRANCH}..HEAD" 2>/dev/null || echo '?')"
    behind="$(git rev-list --count "HEAD..${REMOTE}/${BRANCH}" 2>/dev/null || echo '?')"
    echo "相对 ${REMOTE}/${BRANCH}：本地领先 ${ahead}，落后 ${behind}"
    if [[ "$behind" != "0" ]]; then echo "要合并请跑: bash scripts/remote-sync.sh pull"; fi
    ;;

  pull)
    "$0" fetch "$BRANCH"
    if git merge-base --is-ancestor HEAD "refs/remotes/${REMOTE}/${BRANCH}"; then
      git merge --ff-only "refs/remotes/${REMOTE}/${BRANCH}"
      ok "已快进到 $(git rev-parse --short HEAD)"
    else
      echo "[!] 不能快进（本地有分叉）。本脚本不做自动 rebase/merge，请手动处理。"
      exit 1
    fi
    ;;

  log)
    need_relay
    rgit "log --oneline -10"
    ;;

  push-log)
    sshx "tail -n 30 ${PUSH_LOG} 2>/dev/null" || die "读不到推送日志"
    ;;

  *)
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
