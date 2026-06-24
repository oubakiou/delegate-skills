#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/prepare.sh
# 各 delegate-* skill の scripts/prepare.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# 委譲の準備を 1 回の呼び出しに集約する（前提チェック→モデル解決→チェーン確認→リクエスト生成）。
# 個別スクリプトを別々の bash 往復で呼ぶと各出力が main の context に積もり委譲オーバーヘッドを押し上げるため、
# happy path をこの 1 本に畳んで往復と出力を減らす。
# Usage: prepare.sh <task_type> <type_env_name> <default_model> <parent_task_type_chain_json> <requester_session_id>
#   リクエスト本文 Markdown は stdin から渡す（見出しは build-request.sh と同じ）。
#   parent_task_type_chain_json は top-level 起動なら空 or "[]" でよい。
# stdout: {"model":"...","task_type_chain":[...],"request_file":"...","response_file":"..."}（JSON）
# telemetry: DELEGATE_METRICS_FILE が設定されたときだけ JSONL に proxy metric を追記する
# exit: 2=引数エラー / 3=前提条件不足(npx/jq) / 4=委譲サイクル / 1=md2idx 失敗・空 index/sections

if [ $# -lt 5 ]; then
  echo "Usage: $0 <task_type> <type_env_name> <default_model> <parent_task_type_chain_json> <requester_session_id>  (request body markdown on stdin)" >&2
  exit 2
fi

task_type="$1"
type_env="$2"
default_model="$3"
parent_chain="${4:-[]}"
# 空文字（env 未設定の素通し）も top-level とみなす
[ -z "$parent_chain" ] && parent_chain="[]"
requester_session_id="$5"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# stdin（本文 Markdown）は build-request へ渡す前に先取りする。
# 前段スクリプト（check-md2idx 等）が誤って stdin を消費しても本文を失わないため。
body="$(cat)"

append_metrics() {
  [ -n "${DELEGATE_METRICS_FILE:-}" ] || return 0
  (
    metrics_dir="$(dirname "$DELEGATE_METRICS_FILE")"
    mkdir -p "$metrics_dir"
    jq -cn \
      --arg kind prepare \
      --arg task_type "$task_type" \
      --arg type_env "$type_env" \
      --arg default_model "$default_model" \
      --arg model "$model" \
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
        type_env: $type_env,
        default_model: $default_model,
        model: $model,
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

# 前提条件（npx md2idx 実行可能か）。fail-closed (exit 3)。
"$script_dir/check-md2idx.sh"

# モデル解決（種別env → 既定）
model="$("$script_dir/resolve-model.sh" "$type_env" "$default_model")"

# 多段委譲チェーン（同一種別が二度なら exit 4）。新チェーン（parent + 自種別）を得る。
task_type_chain="$("$script_dir/check-delegate-chain.sh" "$task_type" "$parent_chain")"

# リクエスト生成（先取りした本文を stdin で渡す）
paths="$(printf '%s' "$body" | "$script_dir/build-request.sh" "$task_type" "$task_type_chain" "$requester_session_id")"
request_file="$(printf '%s' "$paths" | jq -r '.request_file')"
response_file="$(printf '%s' "$paths" | jq -r '.response_file')"
body_bytes="$(printf '%s' "$body" | wc -c | tr -d '[:space:]')"
body_chars="$(printf '%s' "$body" | wc -m | tr -d '[:space:]')"
body_lines="$(printf '%s' "$body" | wc -l | tr -d '[:space:]')"
append_metrics

jq -n \
  --arg model "$model" \
  --argjson chain "$task_type_chain" \
  --arg req "$request_file" \
  --arg res "$response_file" \
  '{model: $model, task_type_chain: $chain, request_file: $req, response_file: $res}'
