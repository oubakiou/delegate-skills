#!/usr/bin/env bash
set -euo pipefail

# delegate-imagegen 専用の準備スクリプト。
# protocol v1 の request/response 準備に加えて、他 delegate と同じ env → default のモデル解決を行う。
# Usage: prepare-imagegen.sh <parent_task_type_chain_json> <requester_session_id>
#   リクエスト本文 Markdown は stdin から渡す。
# stdout: {"model":"...","task_type_chain":[...],"request_file":"...","response_file":"...","run_dir":"...","observe_file":"..."}（JSON）
# exit: 2=引数エラー / 3=前提条件不足(npx/jq) / 4=委譲サイクル / 1=md2idx 失敗・空 index/sections

if [ $# -lt 2 ]; then
  echo "Usage: $0 <parent_task_type_chain_json> <requester_session_id>  (request body markdown on stdin)" >&2
  exit 2
fi

task_type="imagegen"
type_env="DELEGATE_IMAGEGEN_MODEL"
default_model="gpt-5"
parent_chain="${1:-[]}"
[ -z "$parent_chain" ] && parent_chain="[]"
requester_session_id="$2"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/observe-json.sh"
body="$(cat)"

append_metrics() {
  [ -n "${DELEGATE_METRICS_FILE:-}" ] || return 0
  (
    metrics_dir="$(dirname "$DELEGATE_METRICS_FILE")"
    mkdir -p "$metrics_dir"
    jq -cn \
      --arg kind prepare_imagegen \
      --arg task_type "$task_type" \
      --arg type_env "$type_env" \
      --arg default_model "$default_model" \
      --arg model "$model" \
      --arg requester_session_id "$requester_session_id" \
      --arg request_file "$request_file" \
      --arg response_file "$response_file" \
      --arg run_dir "$run_dir" \
      --arg observe_file "$observe_file" \
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
        run_dir: $run_dir,
        observe_file: $observe_file,
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
model="$("$script_dir/resolve-model.sh" "$type_env" "$default_model")"
task_type_chain="$("$script_dir/check-delegate-chain.sh" "$task_type" "$parent_chain")"
paths="$(printf '%s' "$body" | "$script_dir/build-request.sh" "$task_type" "$model" "$task_type_chain" "$requester_session_id")"
request_file="$(printf '%s' "$paths" | jq -r '.request_file')"
response_file="$(printf '%s' "$paths" | jq -r '.response_file')"
run_dir="$(printf '%s' "$paths" | jq -r '.run_dir')"
observe_file="$(printf '%s' "$paths" | jq -r '.observe_file')"
body_bytes="$(printf '%s' "$body" | wc -c | tr -d '[:space:]')"
body_chars="$(printf '%s' "$body" | wc -m | tr -d '[:space:]')"
body_lines="$(printf '%s' "$body" | wc -l | tr -d '[:space:]')"
backend="$(delegate_observe_backend_for "$task_type" "$model")"
delegate_observe_init "$observe_file" "$run_dir" "$task_type" "$model" "$backend" "$request_file" "$response_file" "$requester_session_id"
append_metrics

jq -n \
  --arg model "$model" \
  --argjson chain "$task_type_chain" \
  --arg req "$request_file" \
  --arg res "$response_file" \
  --arg run_dir "$run_dir" \
  --arg observe_file "$observe_file" \
  '{model: $model, task_type_chain: $chain, request_file: $req, response_file: $res, run_dir: $run_dir, observe_file: $observe_file}'
