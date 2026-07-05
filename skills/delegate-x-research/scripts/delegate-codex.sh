#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/delegate-codex.sh
# 各 delegate-* skill の scripts/delegate-codex.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# gpt-* モデル指定時の Codex 子プロセス起動ラッパ
# 起動骨格は guarded-webfetch-codex/scripts/quarantine-fetch-codex.sh を流用する。
# Usage: delegate-codex.sh <model> <task_type> <request_file> <response_file> [run_dir] [observe_file] [session_mode] [resume_arg] [session_home]
# stdout: response_file のパスのみ（本文は親 context に入れない）

if [ $# -lt 4 ]; then
  echo "Usage: $0 <model> <task_type> <request_file> <response_file> [run_dir] [observe_file] [session_mode] [resume_arg] [session_home]" >&2
  exit 2
fi

MODEL="$1"
TASK_TYPE="$2"
REQUEST_FILE="$3"
RESPONSE_FILE="$4"
RUN_DIR="${5:-${RESPONSE_FILE%_res.json}}"
OBSERVE_FILE="${6:-${RESPONSE_FILE%_res.json}_observe.json}"
SESSION_MODE="${7:-}"
RESUME_ARG="${8:-}"
SESSION_HOME="${9:-}"

WORK_DIR="$RUN_DIR"
mkdir -p "$WORK_DIR/tmp"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/observe-json.sh"
backend="$(delegate_observe_backend_from_model "$MODEL")"
stdout_capture="$WORK_DIR/worker-stdout.capture"
stderr_capture="$WORK_DIR/worker-stderr.capture"
: >"$stdout_capture"
: >"$stderr_capture"

if [ ! -s "$OBSERVE_FILE" ]; then
  delegate_observe_init "$OBSERVE_FILE" "$WORK_DIR" "$TASK_TYPE" "$MODEL" "$backend" "$REQUEST_FILE" "$RESPONSE_FILE" ""
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

extract_codex_thread_id() {
  jq -R -s -r '
    split("\n")
    | map(select(length > 0) | try fromjson catch empty | select(type == "object"))
    | map(select(.type == "thread.started" and (.thread_id | type == "string")) | .thread_id)
    | last // empty
  ' "$stdout_capture"
}

CODEX_HOME_ISOLATED="$WORK_DIR/codex-home"
if [ "$SESSION_MODE" = "followup" ]; then
  if [ -z "$SESSION_HOME" ] || [ -z "$RESUME_ARG" ]; then
    finish_without_child 5 "ERROR: follow-up requires session_home and resume_id."
  fi
  if [ ! -d "$SESSION_HOME" ]; then
    finish_without_child 5 "ERROR: Codex session_home does not exist: $SESSION_HOME"
  fi
  CODEX_HOME_ISOLATED="$SESSION_HOME"
elif [ "$SESSION_MODE" != "" ] && [ "$SESSION_MODE" != "resumable" ]; then
  finish_without_child 2 "ERROR: session_mode must be empty, resumable, or followup: $SESSION_MODE"
fi

if ! command -v codex >/dev/null 2>&1; then
  finish_without_child 3 "ERROR: codex CLI が見つかりません。"
fi

mkdir -p "$CODEX_HOME_ISOLATED"
REAL_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
[ -f "$REAL_CODEX_HOME/auth.json" ] && cp "$REAL_CODEX_HOME/auth.json" "$CODEX_HOME_ISOLATED/auth.json"

LAST_MSG="$WORK_DIR/codex-last-message.txt"
REPORT_FILE="$(mktemp --tmpdir="$WORK_DIR" "$(basename "$RESPONSE_FILE" .json)_report_XXXXX" --suffix=.md)"

# Codex 子は自身の session id を prompt 内から素直に取得できないため、ラッパが
# response_file のペアトークン（main 事前確保の一意トークン）から responder_session_id を導出して渡す。
RESPONDER_SESSION_ID="codex:${MODEL}:$(basename "$RESPONSE_FILE" .json)"

cleanup() {
  if [ -n "${child_pid:-}" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

PROMPT=$(cat <<PROMPT_EOF
あなたは delegate-skills の隔離ワーカー（task_type=${TASK_TYPE}）です。protocol v1 に従ってください。

1. リクエストを読む: \`bash ${script_dir}/read-request.sh "${REQUEST_FILE}" all\` で全 section を 1 回で丸読みする（読み飛ばせる情報は無いので、段階読みで往復を増やさない）。
2. リクエストの指示に従って作業する。AGENTS.md / CLAUDE.md の規約に従うこと。
3. task_type_chain（${REQUEST_FILE} の .task_type_chain）に自種別を含む種別への再委譲は禁止。
4. 作業報告を Markdown("${REPORT_FILE}") に書き、レスポンスを生成する:
   \`npx md2idx "${REPORT_FILE}" | jq --arg s "<status>" --arg sid "${RESPONDER_SESSION_ID}" '{protocol_version: 1, type: "response", status: \$s, responder_session_id: \$sid} + .' > "${RESPONSE_FILE}"\`
   status は completed | partial | failed | needs_input のいずれか。report.md の見出しは
   Summary / Changed files / Commands / Verification / Findings / Blockers / Error。
   report は簡潔に書く: Summary は 5 行以内。Findings は重要なものに絞る。コマンドの生ログは貼らず、Verification は実行コマンドと結果（exit code / pass・fail）のみ。該当が無い見出しは省く。
5. 最終応答は status の一語のみ（本文は ${RESPONSE_FILE} に書く）。リポジトリ root に report.md を作らない。
PROMPT_EOF
)

codex_args=(exec)
if [ "$SESSION_MODE" = "followup" ]; then
  codex_args+=(
    resume "$RESUME_ARG"
    -m "$MODEL"
    --skip-git-repo-check
    --ignore-user-config
    -c "sandbox_mode=${CODEX_DELEGATE_SANDBOX:-danger-full-access}"
    --json
    --output-last-message "$LAST_MSG"
    "$PROMPT"
  )
else
  codex_args+=(
    -m "$MODEL"
    --skip-git-repo-check
    --ignore-user-config
    --sandbox "${CODEX_DELEGATE_SANDBOX:-danger-full-access}"
    --json
    --output-last-message "$LAST_MSG"
    -C "$REPO_ROOT"
  )
  if [ "$SESSION_MODE" = "" ]; then
    codex_args+=(--ephemeral)
  fi
  codex_args+=("$PROMPT")
fi

# --ignore-rules は付けない: AGENTS.md を読ませて規約遵守させる
cd "$REPO_ROOT"
CODEX_HOME="$CODEX_HOME_ISOLATED" TMPDIR="$WORK_DIR/tmp" codex "${codex_args[@]}" >"$stdout_capture" 2>"$stderr_capture" &
child_pid=$!

if delegate_observe_wait_with_heartbeat "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$child_pid" "$stdout_capture" "$stderr_capture"; then
  child_status=0
else
  child_status=$?
fi

if [ ! -s "$RESPONSE_FILE" ]; then
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

measured_usage="$(delegate_observe_usage_from_capture "$stdout_capture" "$MODEL" "$backend" codex_json || delegate_observe_usage_from_codex_sessions "$CODEX_HOME_ISOLATED" "$MODEL" "$backend" || true)"
delegate_observe_record_usage "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$MODEL" "$REQUEST_FILE" "$RESPONSE_FILE" codex_json "$measured_usage" || true

if [ "$SESSION_MODE" = "resumable" ]; then
  thread_id="$(extract_codex_thread_id)"
  if [ -n "$thread_id" ]; then
    delegate_observe_backend_session_update "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$MODEL" "$thread_id" codex_json resumable "$CODEX_HOME_ISOLATED" || true
  else
    delegate_observe_resume_unavailable "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$MODEL" "Codex thread.started event was not found" "$CODEX_HOME_ISOLATED" || true
  fi
elif [ "$SESSION_MODE" = "followup" ]; then
  delegate_observe_backend_session_update "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$MODEL" "$RESUME_ARG" codex_json resumable "$CODEX_HOME_ISOLATED" || true
fi
record_run_context

printf '%s\n' "$RESPONSE_FILE"
exit "$response_status"
