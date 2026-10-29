#!/usr/bin/env bash
# 部署一个前端扩展到云酒馆并回读校验。
# 用法: bash scripts/deploy.sh <扩展名> [--dry-run]
set -euo pipefail

NAME="${1:-}"
DRY="${2:-}"
REMOTE="${TAVERN_SSH:-tavern}"
REMOTE_DIR="/opt/tavern/extensions/${NAME}"

if [[ -z "$NAME" ]]; then
  echo "用法: bash scripts/deploy.sh <扩展名> [--dry-run]" >&2
  exit 2
fi

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)/src/${NAME}"
if [[ ! -f "${SRC_DIR}/manifest.json" ]]; then
  echo "[ERR] 找不到 ${SRC_DIR}/manifest.json" >&2
  exit 2
fi

# 本地自查
node --check "${SRC_DIR}/index.js"
node -e "const m=require('${SRC_DIR//\\//}/manifest.json');for(const k of ['js','display_name','loading_order'])if(m[k]===undefined)throw new Error('manifest 缺字段: '+k);console.log('[ok] manifest '+m.display_name+' v'+m.version)"
VER="$(node -e "console.log(require('${SRC_DIR//\\//}/manifest.json').version)")"

TMP="$(mktemp -d)"
TAR="${TMP}/${NAME}.tar.gz"
tar -czf "$TAR" -C "$SRC_DIR" .

if [[ "$DRY" == "--dry-run" ]]; then
  echo "[dry-run] 将上传 ${TAR} -> ${REMOTE}:${REMOTE_DIR}"
  tar -tzf "$TAR"
  rm -rf "$TMP"
  exit 0
fi

scp -q "$TAR" "${REMOTE}:/tmp/${NAME}.tar.gz"
ssh "$REMOTE" "set -e
  sudo mkdir -p '${REMOTE_DIR}'
  sudo tar -xzf '/tmp/${NAME}.tar.gz' -C '${REMOTE_DIR}'
  sudo chown -R 1000:1000 '${REMOTE_DIR}'
  rm -f '/tmp/${NAME}.tar.gz'
  sha256sum '${REMOTE_DIR}/index.js' '${REMOTE_DIR}/manifest.json'"
rm -rf "$TMP"

echo "--- 本地 sha256 ---"
sha256sum "${SRC_DIR}/index.js" "${SRC_DIR}/manifest.json"
echo "[done] ${NAME} v${VER} 已部署到 ${REMOTE_DIR}，请硬刷页面（Ctrl+Shift+R）"
