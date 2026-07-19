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

# ORIGINAL_MODEL（suffix 込み）は observe 記録用、MODEL（base）は CLI argv・RESPONDER_SESSION_ID 用。
# observe を base に落とすと resumable 初回の backend_session.model から suffix が消え、
# follow-up validation（suffix 込みの解決値と完全一致比較）が黙って壊れる
model_split="$(delegate_observe_split_model_effort "$ORIGINAL_MODEL")"
MODEL="$(jq -r '.base_model' <<<"$model_split")"
EFFORT="$(jq -r '.effort // empty' <<<"$model_split")"

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

extract_codex_thread_id() {
  jq -R -s -r '
    split("\n")
    | map(select(length > 0) | try fromjson catch empty | select(type == "object"))
    | map(select(.type == "thread.started" and (.thread_id | type == "string")) | .thread_id)
    | last // empty
  ' "$stdout_capture"
}

# prepare を経ない直接起動でも不正な effort 指定を黙って通さない（二重検証）
if ! effort_error="$(delegate_observe_validate_model_effort "$backend" "$ORIGINAL_MODEL" 2>&1)"; then
  finish_without_child 6 "$effort_error"
fi

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

if [ "$SESSION_MODE" = "followup" ]; then
  if [ -s "$CODEX_HOME_ISOLATED/config.toml" ]; then
    mcp_servers="$(delegate_mcp_toml_server_names "$CODEX_HOME_ISOLATED/config.toml")"
    delegate_observe_mcp_config_update "$OBSERVE_FILE" "$WORK_DIR" injected "$mcp_servers" || true
  else
    delegate_observe_mcp_config_update "$OBSERVE_FILE" "$WORK_DIR" none '[]' || true
  fi
else
  mcp_canonical="$(delegate_mcp_extract_codex_user "$REAL_CODEX_HOME")"
  if delegate_mcp_has_servers "$mcp_canonical"; then
    delegate_mcp_render_codex_toml "$mcp_canonical" >"$CODEX_HOME_ISOLATED/config.toml"
    mcp_servers="$(printf '%s' "$mcp_canonical" | jq -c 'keys')"
    delegate_observe_mcp_config_update "$OBSERVE_FILE" "$WORK_DIR" injected "$mcp_servers" || true
  else
    delegate_observe_mcp_config_update "$OBSERVE_FILE" "$WORK_DIR" none '[]' || true
  fi
fi

LAST_MSG="$WORK_DIR/codex-last-message.txt"

# 報告方式は起動前に確定する（codex は構造化最終応答が既定。§docs/feature/delegate-latency-reduction.md）
REPORT_MODE="$(delegate_observe_report_mode_for_backend "$backend")"
REPORT_SCHEMA_FILE="$WORK_DIR/report-schema.json"
delegate_observe_report_schema_json >"$REPORT_SCHEMA_FILE"

# Codex 子は自身の session id を prompt 内から素直に取得できないため、ラッパが
# response_file のペアトークン（main 事前確保の一意トークン）から responder_session_id を導出して渡す。
RESPONDER_SESSION_ID="codex:${MODEL}:$(basename "$RESPONSE_FILE" .json)"

cleanup() {
  if [ -n "${child_pid:-}" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

readonly_constraints="$(delegate_prompt_constraints "$TASK_TYPE" "$RESPONSE_FILE")"

# request は初期 prompt へ埋め込み、read-request の初回往復を消す（gate 超過時は fallback）。
# follow-up は prompt を argv で渡す（`exec resume` の stdin が未実測）ため、単一引数上限
# （MAX_ARG_STRLEN）に収まる縮小 gate を適用する
request_inline_gate=""
if [ "$SESSION_MODE" = "followup" ]; then
  request_inline_gate="$DELEGATE_REQUEST_ARGV_INLINE_MAX"
fi
request_inline=true
if ! request_step="$(delegate_observe_request_prompt_step "$REQUEST_FILE" "$script_dir" "$request_inline_gate")"; then
  request_inline=false
fi

PROMPT=$(cat <<PROMPT_EOF
あなたは delegate-skills の隔離ワーカー（task_type=${TASK_TYPE}）です。protocol v1 に従ってください。

${request_step}
2. リクエストの指示に従って作業する。AGENTS.md / CLAUDE.md の規約に従うこと。${readonly_constraints}
   長時間走り得るコマンドは \`timeout\` 付きで実行し、headless 実行するスクリプトには必ず終了処理（quit 等）を入れ、検証コマンドをバックグラウンド化して放置しない。
3. 作業完了後、最終応答として構造化出力 {status, report_markdown} だけを返す。status は completed | partial | failed | needs_input のいずれか。report_markdown は見出し
   Summary / Changed files / Commands / Verification / Findings / Blockers / Error の Markdown。
   report は簡潔に書く: Summary は 5 行以内。Findings は重要なものに絞る。コマンドの生ログは貼らず、Verification は実行コマンドと結果（exit code / pass・fail）のみ。該当が無い見出しは省く。
   report をファイルに書いたり md2idx / jq でレスポンスを生成したりしない（レスポンス生成は wrapper が行う）。リポジトリ root に report.md を作らない。
PROMPT_EOF
)
PROMPT_FILE="$WORK_DIR/worker-prompt.txt"
printf '%s' "$PROMPT" >"$PROMPT_FILE"

codex_args=(exec)
if [ "$SESSION_MODE" = "followup" ]; then
  codex_args+=(
    resume "$RESUME_ARG"
    -m "$MODEL"
  )
  if [ -n "$EFFORT" ]; then
    codex_args+=(-c "model_reasoning_effort=${EFFORT}")
  fi
  # `codex exec resume` での stdin prompt（positional `-`）は未実測のため、follow-up は
  # argv 渡しを維持する（通常 run は stdin）
  codex_args+=(
    --skip-git-repo-check
    -c "sandbox_mode=${CODEX_DELEGATE_SANDBOX:-danger-full-access}"
    --json
    --output-last-message "$LAST_MSG"
    --output-schema "$REPORT_SCHEMA_FILE"
    "$PROMPT"
  )
else
  codex_args+=(
    -m "$MODEL"
  )
  if [ -n "$EFFORT" ]; then
    codex_args+=(-c "model_reasoning_effort=${EFFORT}")
  fi
  codex_args+=(
    --skip-git-repo-check
    --sandbox "${CODEX_DELEGATE_SANDBOX:-danger-full-access}"
    --json
    --output-last-message "$LAST_MSG"
    --output-schema "$REPORT_SCHEMA_FILE"
    -C "$REPO_ROOT"
  )
  if [ "$SESSION_MODE" = "" ]; then
    codex_args+=(--ephemeral)
  fi
  # prompt は argv ではなく positional `-` + stdin で渡す（ARG_MAX 非依存。ps からも見えない）
  codex_args+=(-)
fi

# --ignore-rules は付けない: AGENTS.md を読ませて規約遵守させる
cd "$REPO_ROOT"
if [ "$SESSION_MODE" = "followup" ]; then
  CODEX_HOME="$CODEX_HOME_ISOLATED" TMPDIR="$WORK_DIR/tmp" codex "${codex_args[@]}" </dev/null >"$stdout_capture" 2>"$stderr_capture" &
else
  CODEX_HOME="$CODEX_HOME_ISOLATED" TMPDIR="$WORK_DIR/tmp" codex "${codex_args[@]}" <"$PROMPT_FILE" >"$stdout_capture" 2>"$stderr_capture" &
fi
child_pid=$!

if delegate_observe_wait_with_heartbeat "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$child_pid" "$stdout_capture" "$stderr_capture" "$RESPONSE_FILE"; then
  child_status=0
else
  child_status=$?
fi

# 構造化最終応答の回収 → wrapper 側で response を組み立てる。parse 失敗は failed response
# へ倒す（fail-closed。後段の response 欠落分岐が処理する）
structured_parse=""
if [ "$REPORT_MODE" = structured ] && [ ! -s "$RESPONSE_FILE" ]; then
  structured_parse=false
  if structured_json="$(delegate_observe_structured_from_last_message "$LAST_MSG")" \
    && delegate_observe_build_response_from_structured "$structured_json" "$RESPONDER_SESSION_ID" "$RESPONSE_FILE" "$WORK_DIR"; then
    structured_parse=true
    DELEGATE_OBSERVE_REPORT_READY_MS="${DELEGATE_OBSERVE_REPORT_READY_MS:-$DELEGATE_OBSERVE_WAIT_TOTAL_MS}"
  fi
fi
delegate_observe_record_timing "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$stdout_capture" \
  "${DELEGATE_OBSERVE_WAIT_TOTAL_MS:-}" "${DELEGATE_OBSERVE_FIRST_USEFUL_MS:-}" "${DELEGATE_OBSERVE_REPORT_READY_MS:-}" "" "$structured_parse" || true

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

measured_usage="$(delegate_observe_usage_from_capture "$stdout_capture" "$ORIGINAL_MODEL" "$backend" codex_json || delegate_observe_usage_from_codex_sessions "$CODEX_HOME_ISOLATED" "$ORIGINAL_MODEL" "$backend" || true)"
delegate_observe_record_usage "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "$REQUEST_FILE" "$RESPONSE_FILE" codex_json "$measured_usage" || true
effort_effective="$(delegate_observe_effort_from_codex_sessions "$CODEX_HOME_ISOLATED" || true)"
delegate_observe_record_effort "$OBSERVE_FILE" "$WORK_DIR" "$EFFORT" "$effort_effective" || true

if [ "$SESSION_MODE" = "resumable" ]; then
  thread_id="$(extract_codex_thread_id)"
  if [ "$child_status" -eq 0 ] && [ "$response_allows_resume" -eq 1 ] && [ -n "$thread_id" ]; then
    delegate_observe_backend_session_update "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "$thread_id" codex_json resumable "$CODEX_HOME_ISOLATED" || true
  elif [ "$child_status" -ne 0 ] || [ "$response_allows_resume" -ne 1 ]; then
    delegate_observe_resume_unavailable "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "Codex run did not complete successfully" "$CODEX_HOME_ISOLATED" || true
  else
    delegate_observe_resume_unavailable "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "Codex thread.started event was not found" "$CODEX_HOME_ISOLATED" || true
  fi
elif [ "$SESSION_MODE" = "followup" ]; then
  if [ "$child_status" -eq 0 ] && [ "$response_allows_resume" -eq 1 ]; then
    delegate_observe_backend_session_update "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "$RESUME_ARG" codex_json resumable "$CODEX_HOME_ISOLATED" || true
  else
    delegate_observe_resume_unavailable "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "Codex follow-up did not complete successfully" "$CODEX_HOME_ISOLATED" || true
  fi
fi
record_run_context

if [ "$response_status" -eq 0 ] && [ "$response_allows_resume" -eq 1 ]; then
  delegate_codex_home_prune "$CODEX_HOME_ISOLATED"
fi

printf '%s\n' "$RESPONSE_FILE"
exit "$response_status"
