#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/read-response.sh
# 各 delegate-* skill の scripts/read-response.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# レスポンスファイルの段階読み取り（protocol v1）。main 側で status → index → 必要 section の順に最安で読む。
# Usage: read-response.sh <response_file> [selector]
#   selector:
#     (省略) | status : .status を出力（既定・最安ゲート）
#     index           : 目次（.index）
#     meta            : protocol_version/type/status/responder_session_id を JSON で出力
#     all             : 全 section を区切り付きで出力
#     <整数N>         : .sections[N] を出力
# exit: 2=引数エラー / 3=前提条件(jq)不足 / 1=ファイル不在・selector 不正・範囲外

if [ $# -lt 1 ]; then
  echo "Usage: $0 <response_file> [status|index|meta|all|<N>]" >&2
  exit 2
fi

response_file="$1"
selector="${2:-status}"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq が見つかりません。" >&2
  exit 3
fi

if [ ! -f "$response_file" ]; then
  echo "ERROR: response_file が見つかりません: $response_file" >&2
  exit 1
fi

case "$selector" in
  status)
    jq -r '.status' "$response_file"
    ;;
  index)
    jq -r '.index' "$response_file"
    ;;
  meta)
    jq '{protocol_version, type, status, responder_session_id}' "$response_file"
    ;;
  all)
    jq -r '.sections | to_entries[] | "===== section[\(.key)] =====\n\(.value)"' "$response_file"
    ;;
  *[!0-9]*)
    echo "ERROR: 不明な selector: $selector（status|index|meta|all|<整数N> のいずれか）" >&2
    exit 1
    ;;
  *)
    jq -r --argjson n "$selector" \
      'if ($n >= 0 and $n < (.sections | length)) then .sections[$n] else error("section[\($n)] は範囲外") end' \
      "$response_file"
    ;;
esac
