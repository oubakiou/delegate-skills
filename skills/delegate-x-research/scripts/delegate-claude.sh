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
ORIGINAL_MODEL="$MODEL"
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
source "$script_dir/prompt-constraints.sh"
source "$script_dir/delegate-mcp.sh"

# ORIGINAL_MODEL（suffix 込み）は observe 記録用、MODEL（base）は CLI argv 用。
# observe を base に落とすと resumable 初回の backend_session.model から suffix が消え、
# follow-up validation（suffix 込みの解決値と完全一致比較）が黙って壊れる
model_split="$(delegate_observe_split_model_effort "$ORIGINAL_MODEL")"
MODEL="$(jq -r '.base_model' <<<"$model_split")"
EFFORT="$(jq -r '.effort // empty' <<<"$model_split")"

RESPONDER_SESSION_ID="claude:${MODEL}:$(basename "$RESPONSE_FILE" .json)"

backend="$(delegate_observe_backend_from_model "$ORIGINAL_MODEL")"
stdout_capture="$WORK_DIR/worker-stdout.capture"
stderr_capture="$WORK_DIR/worker-stderr.capture"
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

claude_session_file_exists() {
  local claude_home="$1"
  local session_id="$2"
  find "$claude_home/projects" -type f -name "${session_id}.jsonl" -print -quit 2>/dev/null | grep -q .
}

# prepare を経ない直接起動でも不正な effort 指定を黙って通さない（二重検証）
if ! effort_error="$(delegate_observe_validate_model_effort "$backend" "$ORIGINAL_MODEL" 2>&1)"; then
  finish_without_child 6 "$effort_error"
fi

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

readonly_constraints="$(delegate_prompt_constraints "$TASK_TYPE" "$RESPONSE_FILE")"

PROMPT=$(cat <<PROMPT_EOF
あなたは delegate-skills の隔離ワーカー（task_type=${TASK_TYPE}）です。protocol v1 に従ってください。

1. リクエストを読む: \`bash ${script_dir}/read-request.sh "${REQUEST_FILE}" all\` で全 section を 1 回で丸読みする（読み飛ばせる情報は無いので、段階読みで往復を増やさない）。
2. リクエストの指示に従って作業する。AGENTS.md / CLAUDE.md の規約に従うこと。${readonly_constraints}
   長時間走り得るコマンドは \`timeout\` 付きで実行し、headless 実行するスクリプトには必ず終了処理（quit 等）を入れ、検証コマンドをバックグラウンド化して放置しない。
3. task_type_chain（${REQUEST_FILE} の .task_type_chain）に自種別を含む種別への再委譲は禁止。
4. 作業報告 Markdown を \`bash ${script_dir}/build-response.sh <status> ${RESPONDER_SESSION_ID} "${RESPONSE_FILE}" <<'REPORT_EOF'\` の heredoc（stdin）で渡して書き、\`REPORT_EOF\` で閉じる。コマンドは必ず \`bash ${script_dir}/build-response.sh\` から始める（\`cat\` / \`printf\` からのパイプ形式は権限 allowlist の先頭一致に合わず拒否され得る）。status は completed | partial | failed | needs_input のいずれか。report の見出しは
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
)
if [ -n "$EFFORT" ]; then
  claude_args+=(--effort "$EFFORT")
fi
claude_args+=(
  --output-format stream-json
  --verbose
  --dangerously-skip-permissions
)
# managed policy が bypass permissions mode を無効化した環境では worker が default
# 権限モードに落ち、allowlist 外のツールは非対話で自動拒否される。protocol の完走に
# 必要な最小ツールを常に事前許可しておく（bypass が効く環境では無害な重複許可）。
minimal_allowed_tools="Bash(bash ${script_dir}/read-request.sh:*),Bash(bash ${script_dir}/build-response.sh:*),Read"

case "$SESSION_MODE" in
  "")
    claude_args+=(--no-session-persistence)
    delegate_observe_mcp_config_update "$OBSERVE_FILE" "$WORK_DIR" shared '[]' || true
    ;;
  resumable)
    parent_claude_config_file="${CLAUDE_CONFIG_DIR:+$CLAUDE_CONFIG_DIR/.claude.json}"
    parent_claude_config_file="${parent_claude_config_file:-$HOME/.claude.json}"
    mcp_canonical="$(delegate_mcp_extract_claude_user "$parent_claude_config_file")"
    if delegate_mcp_has_servers "$mcp_canonical"; then
      mcp_config_file="$CLAUDE_SESSION_HOME/mcp-config.json"
      delegate_mcp_render_claude_mcp_config "$mcp_canonical" >"$mcp_config_file"
      claude_args+=(--mcp-config "$mcp_config_file")
      mcp_servers="$(printf '%s' "$mcp_canonical" | jq -c 'keys')"
      delegate_observe_mcp_config_update "$OBSERVE_FILE" "$WORK_DIR" injected "$mcp_servers" || true
    else
      delegate_observe_mcp_config_update "$OBSERVE_FILE" "$WORK_DIR" none '[]' || true
    fi
    claude_args+=(--session-id "$CLAUDE_SESSION_ID")
    ;;
  followup)
    mcp_config_file="$CLAUDE_SESSION_HOME/mcp-config.json"
    if [ -s "$mcp_config_file" ]; then
      claude_args+=(--mcp-config "$mcp_config_file")
      mcp_servers="$(jq -c 'if (.mcpServers | type) == "object" then .mcpServers | keys else [] end' "$mcp_config_file" 2>/dev/null || printf '[]\n')"
      delegate_observe_mcp_config_update "$OBSERVE_FILE" "$WORK_DIR" injected "$mcp_servers" || true
    else
      delegate_observe_mcp_config_update "$OBSERVE_FILE" "$WORK_DIR" none '[]' || true
    fi
    claude_args+=(--resume "$CLAUDE_SESSION_ID")
    ;;
esac

# read-only 種別はリポジトリ書き込みツールを技術的に除外する（Codex パスでは不可能な防御層）。
# explore は WebSearch / WebFetch / MCP 探索を開放するため allowlist ではなく denylist を使う
# （MCP ツール名は実行環境の MCP 設定次第で、allowlist では事前に列挙できないため）
case "$TASK_TYPE" in
  explore)
    claude_args+=(--allowedTools "$minimal_allowed_tools")
    claude_args+=(--disallowedTools "Edit,MultiEdit,Write,NotebookEdit")
    ;;
  review)
    claude_args+=(--allowedTools "Read,Bash")
    ;;
  *)
    claude_args+=(--allowedTools "${minimal_allowed_tools},Edit,Write")
    ;;
esac

# 子が自作のハングするサブプロセスを待ち続けると外側 watchdog の kill まで復帰機会が無い。
# Bash tool の timeout 上限を注入しておくと、ハングしたコマンドが harness からツールエラーで
# 返り、子が自力で是正（timeout 付き再実行等）できる。0 指定で注入を無効化する。
CHILD_BASH_TIMEOUT_MS="$(delegate_observe_positive_int_or_zero "${DELEGATE_CHILD_BASH_TIMEOUT_MS:-300000}")"
child_env=(TMPDIR="$WORK_DIR/tmp")
if [ "$CHILD_BASH_TIMEOUT_MS" -gt 0 ]; then
  child_env+=(
    BASH_DEFAULT_TIMEOUT_MS="$CHILD_BASH_TIMEOUT_MS"
    BASH_MAX_TIMEOUT_MS="$CHILD_BASH_TIMEOUT_MS"
  )
fi
if [ -n "$CLAUDE_SESSION_HOME" ]; then
  child_env+=(CLAUDE_CONFIG_DIR="$CLAUDE_SESSION_HOME")
fi

cd "$REPO_ROOT"
env "${child_env[@]}" claude "${claude_args[@]}" </dev/null \
  >"$stdout_capture" 2>"$stderr_capture" &
child_pid=$!

if delegate_observe_wait_with_heartbeat "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$child_pid" "$stdout_capture" "$stderr_capture" "$RESPONSE_FILE"; then
  child_status=0
else
  child_status=$?
fi
delegate_observe_record_timing "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$stdout_capture" \
  "${DELEGATE_OBSERVE_WAIT_TOTAL_MS:-}" "${DELEGATE_OBSERVE_FIRST_USEFUL_MS:-}" "${DELEGATE_OBSERVE_REPORT_READY_MS:-}" || true

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

measured_usage="$(delegate_observe_usage_from_capture "$stdout_capture" "$ORIGINAL_MODEL" "$backend" claude_stream_json || true)"
delegate_observe_record_usage "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "$REQUEST_FILE" "$RESPONSE_FILE" claude_stream_json "$measured_usage" || true
delegate_observe_record_effort "$OBSERVE_FILE" "$WORK_DIR" "$EFFORT" "" || true

if [ "$SESSION_MODE" = "resumable" ]; then
  if [ "$child_status" -eq 0 ] && [ "$response_allows_resume" -eq 1 ] && claude_session_file_exists "$CLAUDE_SESSION_HOME" "$CLAUDE_SESSION_ID"; then
    delegate_observe_backend_session_update "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "$CLAUDE_SESSION_ID" session_id_arg resumable "$CLAUDE_SESSION_HOME" || true
  elif [ "$child_status" -ne 0 ] || [ "$response_allows_resume" -ne 1 ]; then
    delegate_observe_resume_unavailable "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "Claude run did not complete successfully" "$CLAUDE_SESSION_HOME" || true
  else
    delegate_observe_resume_unavailable "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "Claude session file was not created" "$CLAUDE_SESSION_HOME" || true
  fi
elif [ "$SESSION_MODE" = "followup" ]; then
  if [ "$child_status" -eq 0 ] && [ "$response_allows_resume" -eq 1 ]; then
    delegate_observe_backend_session_update "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "$CLAUDE_SESSION_ID" session_id_arg resumable "$CLAUDE_SESSION_HOME" || true
  else
    delegate_observe_resume_unavailable "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "Claude follow-up did not complete successfully" "$CLAUDE_SESSION_HOME" || true
  fi
fi
record_run_context

printf '%s\n' "$RESPONSE_FILE"
exit "$response_status"
