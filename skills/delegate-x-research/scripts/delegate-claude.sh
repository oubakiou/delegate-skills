#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/delegate-claude.sh
# 各 delegate-* skill の scripts/delegate-claude.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# Claude 系モデル指定時の claude -p 子プロセス起動ラッパ
# 起動骨格は delegate-codex.sh と対称構造。
# Usage: delegate-claude.sh <model> <task_type> <request_file> <response_file> [run_dir] [observe_file] [session_mode] [resume_arg] [session_home]
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

RESPONDER_SESSION_ID="claude:${MODEL}:$(basename "$RESPONSE_FILE" .json)"

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

claude_session_file_exists() {
  local claude_home="$1"
  local session_id="$2"
  find "$claude_home/projects" -type f -name "${session_id}.jsonl" -print -quit 2>/dev/null | grep -q .
}

CLAUDE_SESSION_HOME=""
CLAUDE_SESSION_ID=""
case "$SESSION_MODE" in
  "")
    ;;
  resumable)
    CLAUDE_SESSION_HOME="$WORK_DIR/claude-config"
    mkdir -p "$CLAUDE_SESSION_HOME"
    real_claude_config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
    [ -f "$real_claude_config/.credentials.json" ] && cp "$real_claude_config/.credentials.json" "$CLAUDE_SESSION_HOME/.credentials.json"
    CLAUDE_SESSION_ID="$(cat /proc/sys/kernel/random/uuid)"
    ;;
  followup)
    if [ -z "$SESSION_HOME" ] || [ -z "$RESUME_ARG" ]; then
      finish_without_child 5 "ERROR: follow-up requires session_home and resume_id."
    fi
    if ! claude_session_file_exists "$SESSION_HOME" "$RESUME_ARG"; then
      finish_without_child 5 "ERROR: Claude resume session file is missing for resume_id: $RESUME_ARG"
    fi
    CLAUDE_SESSION_HOME="$SESSION_HOME"
    CLAUDE_SESSION_ID="$RESUME_ARG"
    ;;
  *)
    finish_without_child 2 "ERROR: session_mode must be empty, resumable, or followup: $SESSION_MODE"
    ;;
esac

if ! command -v claude >/dev/null 2>&1; then
  finish_without_child 3 "ERROR: claude CLI が見つかりません。"
fi

PROMPT=$(cat <<PROMPT_EOF
あなたは delegate-skills の隔離ワーカー（task_type=${TASK_TYPE}）です。protocol v1 に従ってください。

1. リクエストを読む: \`bash ${script_dir}/read-request.sh "${REQUEST_FILE}" all\` で全 section を 1 回で丸読みする（読み飛ばせる情報は無いので、段階読みで往復を増やさない）。
2. リクエストの指示に従って作業する。AGENTS.md / CLAUDE.md の規約に従うこと。
3. task_type_chain（${REQUEST_FILE} の .task_type_chain）に自種別を含む種別への再委譲は禁止。
4. 作業報告 Markdown を stdin で \`bash ${script_dir}/build-response.sh <status> ${RESPONDER_SESSION_ID} "${RESPONSE_FILE}"\` に渡して書く。status は completed | partial | failed | needs_input のいずれか。report の見出しは
   Summary / Changed files / Commands / Verification / Findings / Blockers / Error。
   report は簡潔に書く: Summary は 5 行以内。Findings は重要なものに絞る。コマンドの生ログは貼らず、Verification は実行コマンドと結果（exit code / pass・fail）のみ。該当が無い見出しは省く。
5. 最終応答は status の一語のみ（本文は ${RESPONSE_FILE} に書く）。
PROMPT_EOF
)

cleanup() {
  if [ -n "${child_pid:-}" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

claude_args=(
  -p "$PROMPT"
  --model "$MODEL"
  --output-format stream-json
  --verbose
  --dangerously-skip-permissions
)

case "$SESSION_MODE" in
  "")
    claude_args+=(--no-session-persistence)
    ;;
  resumable)
    claude_args+=(--session-id "$CLAUDE_SESSION_ID")
    ;;
  followup)
    claude_args+=(--resume "$CLAUDE_SESSION_ID")
    ;;
esac

# read-only 種別は Edit/Write を技術的に除外する（Codex パスでは不可能な防御層）
case "$TASK_TYPE" in
  explore|review)
    claude_args+=(--allowedTools "Read,Bash")
    ;;
esac

cd "$REPO_ROOT"
if [ -n "$CLAUDE_SESSION_HOME" ]; then
  CLAUDE_CONFIG_DIR="$CLAUDE_SESSION_HOME" TMPDIR="$WORK_DIR/tmp" claude "${claude_args[@]}" \
    >"$stdout_capture" 2>"$stderr_capture" &
else
  TMPDIR="$WORK_DIR/tmp" claude "${claude_args[@]}" \
    >"$stdout_capture" 2>"$stderr_capture" &
fi
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

measured_usage="$(delegate_observe_usage_from_capture "$stdout_capture" "$MODEL" "$backend" claude_stream_json || true)"
delegate_observe_record_usage "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$MODEL" "$REQUEST_FILE" "$RESPONSE_FILE" claude_stream_json "$measured_usage" || true

if [ "$SESSION_MODE" = "resumable" ]; then
  if claude_session_file_exists "$CLAUDE_SESSION_HOME" "$CLAUDE_SESSION_ID"; then
    delegate_observe_backend_session_update "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$MODEL" "$CLAUDE_SESSION_ID" session_id_arg resumable "$CLAUDE_SESSION_HOME" || true
  else
    delegate_observe_resume_unavailable "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$MODEL" "Claude session file was not created" "$CLAUDE_SESSION_HOME" || true
  fi
elif [ "$SESSION_MODE" = "followup" ]; then
  delegate_observe_backend_session_update "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$MODEL" "$CLAUDE_SESSION_ID" session_id_arg resumable "$CLAUDE_SESSION_HOME" || true
fi
record_run_context

printf '%s\n' "$RESPONSE_FILE"
exit "$response_status"
