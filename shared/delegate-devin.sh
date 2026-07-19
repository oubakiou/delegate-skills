#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/delegate-devin.sh
# 各 delegate-* skill の scripts/delegate-devin.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# swe-* / devin-* モデル指定時の Devin CLI 子プロセス起動ラッパ
# 起動骨格は delegate-claude.sh と対称構造。
# Usage: delegate-devin.sh <model> <task_type> <request_file> <response_file> [run_dir] [observe_file] [session_mode] [resume_arg] [session_home]
#   <model> は swe-*（そのまま devin CLI に渡す）または devin-*（プレフィックスを剥離して渡す）
# stdout: response_file のパスのみ（本文は親 context に入れない）

if [ $# -lt 4 ]; then
  echo "Usage: $0 <model> <task_type> <request_file> <response_file> [run_dir] [observe_file] [session_mode] [resume_arg] [session_home]" >&2
  exit 2
fi

MODEL="$1"
ORIGINAL_MODEL="$MODEL"
TASK_TYPE="$2"
REQUEST_FILE="$3"
RESPONSE_FILE="$4"
RUN_DIR="${5:-${RESPONSE_FILE%_res.json}}"
OBSERVE_FILE="${6:-${RESPONSE_FILE%_res.json}_observe.json}"
SESSION_MODE="${7:-}"
RESUME_ARG="${8:-}"
SESSION_HOME="${9:-}"

# devin-* プレフィックスは剥離して devin CLI に渡す（devin-glm-5.2 → glm-5.2）
# swe-* は devin CLI がそのまま受理するので剥離しない
case "$MODEL" in
  devin-*)
    MODEL="${MODEL#devin-}"
    ;;
esac

WORK_DIR="$RUN_DIR"
mkdir -p "$WORK_DIR/tmp"

RESPONDER_SESSION_ID="devin:${MODEL}:$(basename "$RESPONSE_FILE" .json)"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/observe-json.sh"
source "$script_dir/prompt-constraints.sh"

backend="$(delegate_observe_backend_from_model "$ORIGINAL_MODEL")"
stdout_capture="$WORK_DIR/worker-stdout.capture"
stderr_capture="$WORK_DIR/worker-stderr.capture"
devin_export="$WORK_DIR/devin-export.json"
: >"$stdout_capture"
: >"$stderr_capture"

if [ ! -s "$OBSERVE_FILE" ]; then
  delegate_observe_init "$OBSERVE_FILE" "$WORK_DIR" "$TASK_TYPE" "$ORIGINAL_MODEL" "$backend" "$REQUEST_FILE" "$RESPONSE_FILE" ""
fi

finish_without_child() {
  local exit_code="$1"
  local message="$2"

  printf '%s\n' "$message" >"$stderr_capture"
  delegate_observe_write_failed_response "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$RESPONSE_FILE" "$exit_code" || true
  delegate_observe_heartbeat "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$$" "$stdout_capture" "$stderr_capture"
  delegate_observe_import_streams "$OBSERVE_FILE" "$WORK_DIR" "$stdout_capture" "$stderr_capture"
  if declare -F record_run_context >/dev/null; then
    record_run_context
  fi
  printf '%s\n' "$RESPONSE_FILE"
  exit "$exit_code"
}

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
WORKTREE_ROOT="$REPO_ROOT"

record_run_context() {
  if [ "$SESSION_MODE" = "resumable" ] || [ "$SESSION_MODE" = "followup" ]; then
    delegate_observe_run_context_update "$OBSERVE_FILE" "$WORK_DIR" "$REPO_ROOT" "$WORKTREE_ROOT" || true
  fi
}

# effort suffix は devin backend に指定手段がないため、CLI 起動前に fail-closed にする
if ! effort_error="$(delegate_observe_validate_model_effort "$backend" "$ORIGINAL_MODEL" 2>&1)"; then
  finish_without_child 6 "$effort_error"
fi

extract_devin_session_id() {
  if [ ! -s "$devin_export" ]; then
    return 1
  fi
  jq -r '.session_id // .session.id // empty' "$devin_export"
}

case "$SESSION_MODE" in
  "")
    ;;
  resumable)
    ;;
  followup)
    if [ -z "$RESUME_ARG" ]; then
      finish_without_child 5 "ERROR: follow-up requires resume_id."
    fi
    ;;
  *)
    finish_without_child 2 "ERROR: session_mode must be empty, resumable, or followup: $SESSION_MODE"
    ;;
esac

if ! command -v devin >/dev/null 2>&1; then
  finish_without_child 3 "ERROR: devin CLI が見つかりません。"
fi

readonly_constraints="$(delegate_prompt_constraints "$TASK_TYPE" "$RESPONSE_FILE")"

PROMPT=$(cat <<PROMPT_EOF
あなたは delegate-skills の隔離ワーカー（task_type=${TASK_TYPE}）です。protocol v1 に従ってください。

1. リクエストを読む: \`bash ${script_dir}/read-request.sh "${REQUEST_FILE}" all\` で全 section を 1 回で丸読みする（読み飛ばせる情報は無いので、段階読みで往復を増やさない）。
2. リクエストの指示に従って作業する。AGENTS.md / CLAUDE.md の規約に従うこと。${readonly_constraints}
   長時間走り得るコマンドは \`timeout\` 付きで実行し、headless 実行するスクリプトには必ず終了処理（quit 等）を入れ、検証コマンドをバックグラウンド化して放置しない。
3. task_type_chain（${REQUEST_FILE} の .task_type_chain）に自種別を含む種別への再委譲は禁止。
4. 作業報告 Markdown を stdin で \`bash ${script_dir}/build-response.sh <status> ${RESPONDER_SESSION_ID} "${RESPONSE_FILE}"\` に渡して書く。status は completed | partial | failed | needs_input のいずれか。report の見出しは
   Summary / Changed files / Commands / Verification / Findings / Blockers / Error。
   report は簡潔に書く: Summary は 5 行以内。Findings は重要なものに絞る。コマンドの生ログは貼らず、Verification は実行コマンドと結果（exit code / pass・fail）のみ。該当が無い見出しは省く。
5. 最終応答は status の一語のみ（本文は ${RESPONSE_FILE} に書く）。
PROMPT_EOF
)

# --permission-mode dangerous は claude --dangerously-skip-permissions と同等（非対話のため permission prompt に応答できない）
# AGENTS.md は devin が自動で読む（無効化不可）ため --ignore-rules 相当は不要
devin_args=(
  -p "$PROMPT"
  --model "$MODEL"
  --permission-mode dangerous
  --export "$devin_export"
)

if [ "$SESSION_MODE" = "followup" ]; then
  devin_args+=(--resume "$RESUME_ARG")
fi

delegate_observe_mcp_config_update "$OBSERVE_FILE" "$WORK_DIR" shared '[]' || true

cleanup() {
  if [ -n "${child_pid:-}" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

cd "$REPO_ROOT"
TMPDIR="$WORK_DIR/tmp" devin "${devin_args[@]}" </dev/null \
  >"$stdout_capture" 2>"$stderr_capture" &
child_pid=$!

if delegate_observe_wait_with_heartbeat "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$child_pid" "$stdout_capture" "$stderr_capture" "$RESPONSE_FILE"; then
  child_status=0
else
  child_status=$?
fi
delegate_observe_record_timing "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$stdout_capture" \
  "${DELEGATE_OBSERVE_WAIT_TOTAL_MS:-}" "${DELEGATE_OBSERVE_FIRST_USEFUL_MS:-}" "${DELEGATE_OBSERVE_REPORT_READY_MS:-}" "$devin_export" || true

response_generated_by_worker=1
if [ ! -s "$RESPONSE_FILE" ]; then
  response_generated_by_worker=0
  response_status="$child_status"
  [ "$response_status" -eq 0 ] && response_status=1
  if ! delegate_observe_write_failed_response "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$RESPONSE_FILE" "$response_status"; then
    if [ -s "$stderr_capture" ]; then
      cat "$stderr_capture" >&2
    fi
  fi
else
  delegate_observe_write_companion_markdown "$RESPONSE_FILE"
  response_status="$child_status"
fi
response_allows_resume=0
if [ "$response_generated_by_worker" -eq 1 ]; then
  response_protocol_status="$(jq -r '.status // empty' "$RESPONSE_FILE" 2>/dev/null || true)"
  if [ -n "$response_protocol_status" ] && [ "$response_protocol_status" != "failed" ]; then
    response_allows_resume=1
  fi
fi

measured_usage="$(delegate_observe_usage_from_devin_export "$devin_export" "$ORIGINAL_MODEL" "$backend" || delegate_observe_usage_from_capture "$stdout_capture" "$ORIGINAL_MODEL" "$backend" devin_json || true)"
delegate_observe_record_usage "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "$REQUEST_FILE" "$RESPONSE_FILE" devin_atif_export "$measured_usage" || true
delegate_observe_record_effort "$OBSERVE_FILE" "$WORK_DIR" "" "" || true

if [ "$SESSION_MODE" = "resumable" ]; then
  devin_session_id="$(extract_devin_session_id || true)"
  if [ "$child_status" -eq 0 ] && [ "$response_allows_resume" -eq 1 ] && [ -n "$devin_session_id" ]; then
    delegate_observe_backend_session_update "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "$devin_session_id" devin_atif_export resumable "" || true
  elif [ "$child_status" -ne 0 ] || [ "$response_allows_resume" -ne 1 ]; then
    delegate_observe_resume_unavailable "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "Devin run did not complete successfully" || true
  else
    delegate_observe_resume_unavailable "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "Devin export session_id was not found" || true
  fi
elif [ "$SESSION_MODE" = "followup" ]; then
  if [ "$child_status" -eq 0 ] && [ "$response_allows_resume" -eq 1 ]; then
    delegate_observe_backend_session_update "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "$RESUME_ARG" devin_atif_export resumable "" || true
  else
    delegate_observe_resume_unavailable "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "Devin follow-up did not complete successfully" || true
  fi
fi
record_run_context

printf '%s\n' "$RESPONSE_FILE"
exit "$response_status"
