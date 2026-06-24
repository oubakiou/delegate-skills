#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/read-request.sh
# 各 delegate-* skill の scripts/read-request.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# リクエストファイルの段階読み取り（protocol v1）。worker 側で index → 必要 section の順に読む。
# Usage: read-request.sh <request_file> [selector]
#   selector:
#     (省略) | index : 目次（.index）を出力（既定）
#     meta            : protocol_version/type/task_type/task_type_chain/requester_session_id を JSON で出力
#     all             : 全 section を区切り付きで出力
#     <整数N>         : .sections[N] を出力
# exit: 2=引数エラー / 3=前提条件(jq)不足 / 1=ファイル不在・selector 不正・範囲外

if [ $# -lt 1 ]; then
  echo "Usage: $0 <request_file> [index|meta|all|<N>]" >&2
  exit 2
fi

request_file="$1"
selector="${2:-index}"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq が見つかりません。" >&2
  exit 3
fi

if [ ! -f "$request_file" ]; then
  echo "ERROR: request_file が見つかりません: $request_file" >&2
  exit 1
fi

case "$selector" in
  index)
    jq -r '.index' "$request_file"
    ;;
  meta)
    jq '{protocol_version, type, task_type, task_type_chain, requester_session_id}' "$request_file"
    ;;
  all)
    jq -r '.sections | to_entries[] | "===== section[\(.key)] =====\n\(.value)"' "$request_file"
    ;;
  *[!0-9]*)
    echo "ERROR: 不明な selector: $selector（index|meta|all|<整数N> のいずれか）" >&2
    exit 1
    ;;
  *)
    jq -r --argjson n "$selector" \
      'if ($n >= 0 and $n < (.sections | length)) then .sections[$n] else error("section[\($n)] は範囲外") end' \
      "$request_file"
    ;;
esac
