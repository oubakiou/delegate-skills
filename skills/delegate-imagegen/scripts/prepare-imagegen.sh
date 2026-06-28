#!/usr/bin/env bash
set -euo pipefail

# delegate-imagegen 専用の準備スクリプト。
# 既存 delegate のモデル解決は使わず、protocol v1 の request/response 準備だけを行う。
# Usage: prepare-imagegen.sh <parent_task_type_chain_json> <requester_session_id>
#   リクエスト本文 Markdown は stdin から渡す。
# stdout: {"task_type_chain":[...],"request_file":"...","response_file":"..."}（JSON）
# exit: 2=引数エラー / 3=前提条件不足(npx/jq) / 4=委譲サイクル / 1=md2idx 失敗・空 index/sections

if [ $# -lt 2 ]; then
  echo "Usage: $0 <parent_task_type_chain_json> <requester_session_id>  (request body markdown on stdin)" >&2
  exit 2
fi

task_type="imagegen"
parent_chain="${1:-[]}"
[ -z "$parent_chain" ] && parent_chain="[]"
requester_session_id="$2"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
body="$(cat)"

append_metrics() {
  [ -n "${DELEGATE_METRICS_FILE:-}" ] || return 0
  (
    metrics_dir="$(dirname "$DELEGATE_METRICS_FILE")"
    mkdir -p "$metrics_dir"
    jq -cn \
      --arg kind prepare_imagegen \
      --arg task_type "$task_type" \
      --arg requester_session_id "$requester_session_id" \
      --arg request_file "$request_file" \
      --arg response_file "$response_file" \
      --argjson task_type_chain "$task_type_chain" \
      --argjson body_bytes "$body_bytes" \
      --argjson body_chars "$body_chars" \
      --argjson body_lines "$body_lines" \
      --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{
        kind: $kind,
        ts: $ts,
        task_type: $task_type,
        requester_session_id: $requester_session_id,
        task_type_chain: $task_type_chain,
        request_file: $request_file,
        response_file: $response_file,
        body: {
          bytes: $body_bytes,
          chars: $body_chars,
          lines: $body_lines,
          estimated_tokens: (($body_chars + 3) / 4 | floor)
        }
      }' >>"$DELEGATE_METRICS_FILE"
  ) >/dev/null 2>&1 || true
}

"$script_dir/check-md2idx.sh"
task_type_chain="$("$script_dir/check-delegate-chain.sh" "$task_type" "$parent_chain")"
paths="$(printf '%s' "$body" | "$script_dir/build-request.sh" "$task_type" "$task_type_chain" "$requester_session_id")"
request_file="$(printf '%s' "$paths" | jq -r '.request_file')"
response_file="$(printf '%s' "$paths" | jq -r '.response_file')"
body_bytes="$(printf '%s' "$body" | wc -c | tr -d '[:space:]')"
body_chars="$(printf '%s' "$body" | wc -m | tr -d '[:space:]')"
body_lines="$(printf '%s' "$body" | wc -l | tr -d '[:space:]')"
append_metrics

jq -n \
  --argjson chain "$task_type_chain" \
  --arg req "$request_file" \
  --arg res "$response_file" \
  '{task_type_chain: $chain, request_file: $req, response_file: $res}'
