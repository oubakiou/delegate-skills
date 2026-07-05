#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/prepare.sh
# 各 delegate-* skill の scripts/prepare.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# 委譲の準備を 1 回の呼び出しに集約する（前提チェック→モデル解決→チェーン確認→リクエスト生成）。
# 個別スクリプトを別々の bash 往復で呼ぶと各出力が main の context に積もり委譲オーバーヘッドを押し上げるため、
# happy path をこの 1 本に畳んで往復と出力を減らす。
# Usage: prepare.sh <task_type> <type_env_name> <default_model> <parent_task_type_chain_json> <requester_session_id> [session_mode]
#   リクエスト本文 Markdown は stdin から渡す（見出しは build-request.sh と同じ）。
#   parent_task_type_chain_json は top-level 起動なら空 or "[]" でよい。
#   session_mode は空（通常）| resumable | followup=<前回observe_fileパス>。
# stdout: {"model":"...","model_source":"env|default|followup","task_type_chain":[...],"request_file":"...","response_file":"...","run_dir":"...","observe_file":"..."}（JSON）
# telemetry: DELEGATE_METRICS_FILE が設定されたときだけ JSONL に proxy metric を追記する
# exit: 2=引数エラー / 3=前提条件不足(npx/jq) / 4=委譲サイクル / 5=follow-up 検証失敗 / 1=md2idx 失敗・空 index/sections

if [ $# -lt 5 ]; then
  echo "Usage: $0 <task_type> <type_env_name> <default_model> <parent_task_type_chain_json> <requester_session_id> [session_mode]  (request body markdown on stdin)" >&2
  exit 2
fi

task_type="$1"
type_env="$2"
default_model="$3"
parent_chain="${4:-[]}"
# 空文字（env 未設定の素通し）も top-level とみなす
[ -z "$parent_chain" ] && parent_chain="[]"
requester_session_id="$5"
session_mode_arg="${6:-}"
session_mode=""
previous_observe_file=""

case "$session_mode_arg" in
  "")
    ;;
  resumable)
    session_mode="resumable"
    ;;
  followup=*)
    session_mode="followup"
    previous_observe_file="${session_mode_arg#followup=}"
    if [ -z "$previous_observe_file" ]; then
      echo "ERROR: followup session_mode requires a previous observe_file path." >&2
      exit 2
    fi
    ;;
  *)
    echo "ERROR: session_mode must be empty, resumable, or followup=<previous_observe_file>: $session_mode_arg" >&2
    exit 2
    ;;
esac

if [ -n "$session_mode" ]; then
  case "$task_type" in
    implement | chore)
      ;;
    *)
      echo "ERROR: session_mode is only supported for implement/chore tasks: $task_type" >&2
      exit 2
      ;;
  esac
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/observe-json.sh"

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
      --arg model_source "$model_source" \
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
        model_source: $model_source,
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

# 前提条件（npx md2idx 実行可能か）。fail-closed (exit 3)。
bash "$script_dir/check-md2idx.sh"

# モデル解決（種別env → 既定）
if [ "$session_mode" = "followup" ]; then
  if [ ! -s "$previous_observe_file" ]; then
    delegate_observe_validate_followup "$previous_observe_file" "" "" "$PWD" "$PWD" || exit 5
  fi
  previous_resume_metadata="$(jq -e -c \
    '{
      backend: .backend_session.backend,
      model: .backend_session.model,
      resume_id: .backend_session.resume_id,
      resume_source: (.backend_session.resume_source // ""),
      backend_session_home: (.backend_session.home_dir // ""),
      lineage_id: .lineage.lineage_id
    }' "$previous_observe_file")" || {
      echo "follow-up unavailable: previous observe JSON is invalid" >&2
      exit 5
    }
  model="$(jq -r '.model // empty' <<<"$previous_resume_metadata")"
  model_source="followup"
else
  if [ -n "${!type_env:-}" ]; then
    model_source="env"
  else
    model_source="default"
  fi
  model="$(bash "$script_dir/resolve-model.sh" "$type_env" "$default_model")"
fi
backend="$(delegate_observe_backend_for "$task_type" "$model")"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
worktree_root="$repo_root"

if [ "$session_mode" = "followup" ]; then
  if ! delegate_observe_validate_followup "$previous_observe_file" "$backend" "$model" "$repo_root" "$worktree_root"; then
    exit 5
  fi
  if [ -z "$(jq -r '.lineage_id // empty' <<<"$previous_resume_metadata")" ]; then
    echo "follow-up unavailable: lineage.lineage_id is missing" >&2
    exit 5
  fi
fi

# 多段委譲チェーン（同一種別が二度なら exit 4）。新チェーン（parent + 自種別）を得る。
task_type_chain="$(bash "$script_dir/check-delegate-chain.sh" "$task_type" "$parent_chain")"

# リクエスト生成（先取りした本文を stdin で渡す）
paths="$(printf '%s' "$body" | bash "$script_dir/build-request.sh" "$task_type" "$model" "$task_type_chain" "$requester_session_id")"
request_file="$(printf '%s' "$paths" | jq -r '.request_file')"
response_file="$(printf '%s' "$paths" | jq -r '.response_file')"
run_dir="$(printf '%s' "$paths" | jq -r '.run_dir')"
observe_file="$(printf '%s' "$paths" | jq -r '.observe_file')"
body_bytes="$(printf '%s' "$body" | wc -c | tr -d '[:space:]')"
body_chars="$(printf '%s' "$body" | wc -m | tr -d '[:space:]')"
body_lines="$(printf '%s' "$body" | wc -l | tr -d '[:space:]')"
delegate_observe_init "$observe_file" "$run_dir" "$task_type" "$model" "$backend" "$request_file" "$response_file" "$requester_session_id" "$model_source"
lineage_id=""
resume_id=""
resume_source=""
backend_session_home=""
if [ "$session_mode" = "resumable" ]; then
  lineage_id="$(basename "$run_dir")"
  delegate_observe_lineage_update "$observe_file" "$run_dir" "$lineage_id"
  delegate_observe_run_context_update "$observe_file" "$run_dir" "$repo_root" "$worktree_root"
elif [ "$session_mode" = "followup" ]; then
  lineage_id="$(jq -r '.lineage_id // empty' <<<"$previous_resume_metadata")"
  resume_id="$(jq -r '.resume_id // empty' <<<"$previous_resume_metadata")"
  resume_source="$(jq -r '.resume_source // empty' <<<"$previous_resume_metadata")"
  backend_session_home="$(jq -r '.backend_session_home // empty' <<<"$previous_resume_metadata")"
  delegate_observe_lineage_update "$observe_file" "$run_dir" "$lineage_id" "$previous_observe_file"
  delegate_observe_run_context_update "$observe_file" "$run_dir" "$repo_root" "$worktree_root"
fi
append_metrics

if [ -z "$session_mode" ]; then
  jq -n \
    --arg model "$model" \
    --arg model_source "$model_source" \
    --argjson chain "$task_type_chain" \
    --arg req "$request_file" \
    --arg res "$response_file" \
    --arg run_dir "$run_dir" \
    --arg observe_file "$observe_file" \
    '{model: $model, model_source: $model_source, task_type_chain: $chain, request_file: $req, response_file: $res, run_dir: $run_dir, observe_file: $observe_file}'
elif [ "$session_mode" = "resumable" ]; then
  jq -n \
    --arg model "$model" \
    --arg model_source "$model_source" \
    --argjson chain "$task_type_chain" \
    --arg req "$request_file" \
    --arg res "$response_file" \
    --arg run_dir "$run_dir" \
    --arg observe_file "$observe_file" \
    --arg session_mode "$session_mode" \
    --arg lineage_id "$lineage_id" \
    '{model: $model, model_source: $model_source, task_type_chain: $chain, request_file: $req, response_file: $res, run_dir: $run_dir, observe_file: $observe_file, session_mode: $session_mode, lineage_id: $lineage_id}'
else
  jq -n \
    --arg model "$model" \
    --arg model_source "$model_source" \
    --argjson chain "$task_type_chain" \
    --arg req "$request_file" \
    --arg res "$response_file" \
    --arg run_dir "$run_dir" \
    --arg observe_file "$observe_file" \
    --arg session_mode "$session_mode" \
    --arg lineage_id "$lineage_id" \
    --arg resume_id "$resume_id" \
    --arg resume_source "$resume_source" \
    --arg backend_session_home "$backend_session_home" \
    '{model: $model, model_source: $model_source, task_type_chain: $chain, request_file: $req, response_file: $res, run_dir: $run_dir, observe_file: $observe_file, session_mode: $session_mode, lineage_id: $lineage_id, resume_id: $resume_id, resume_source: $resume_source, backend_session_home: $backend_session_home}'
fi
