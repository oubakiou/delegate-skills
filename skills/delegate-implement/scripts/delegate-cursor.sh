#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/delegate-cursor.sh
# 各 delegate-* skill の scripts/delegate-cursor.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# composer-* / cursor-* モデル指定時の Cursor agent CLI 子プロセス起動ラッパ
# 起動骨格は delegate-claude.sh と対称構造。
# Usage: delegate-cursor.sh <model> <task_type> <request_file> <response_file> [run_dir] [observe_file] [session_mode] [resume_arg] [session_home]
#   <model> は composer-*（そのまま agent CLI に渡す）または cursor-*（プレフィックスを剥離して渡す）
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

# cursor-* プレフィックスは剥離して agent CLI に渡す（cursor-glm-5.2-high → glm-5.2-high）
# composer-* は Cursor 専用モデルなのでそのまま渡す
case "$MODEL" in
  cursor-*)
    MODEL="${MODEL#cursor-}"
    ;;
esac

WORK_DIR="$RUN_DIR"
mkdir -p "$WORK_DIR/tmp"

RESPONDER_SESSION_ID="cursor:${MODEL}:$(basename "$RESPONSE_FILE" .json)"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/observe-json.sh"

readonly_constraints=""
case "$TASK_TYPE" in
  explore|review)
    readonly_constraints="
read-only 制約: リポジトリのファイル編集・git 書き込み・push は禁止。調査（Read / Grep / git diff 等）のみ。${RESPONSE_FILE} への報告生成（build-response.sh 実行）は可。"
    ;;
esac

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

CURSOR_CHAT_ID=""
case "$SESSION_MODE" in
  "")
    ;;
  resumable)
    ;;
  followup)
    if [ -z "$RESUME_ARG" ]; then
      finish_without_child 5 "ERROR: follow-up requires resume_id."
    fi
    CURSOR_CHAT_ID="$RESUME_ARG"
    ;;
  *)
    finish_without_child 2 "ERROR: session_mode must be empty, resumable, or followup: $SESSION_MODE"
    ;;
esac

if ! command -v agent >/dev/null 2>&1; then
  finish_without_child 3 "ERROR: agent CLI が見つかりません。"
fi

# Cursor agent CLI は起動時に <config dir>/cli-config.json を tmp ファイル + rename で
# 書き換えるため、共有 config のままだと並列 dispatch 同士で rename が競合し
# 片方が ENOENT で即死し得る。CURSOR_CONFIG_DIR を run_dir 配下へ隔離し、
# authInfo を含む既存 cli-config.json をコピーしてログインを維持する
# （codex backend の CODEX_HOME 隔離と対称）。config dir の解決順
# （CURSOR_CONFIG_DIR → XDG_CONFIG_HOME/cursor → ~/.cursor）は CLI 本体と揃える。
# CURSOR_CONFIG_DIR 未対応の古い CLI では無視され、従来の共有 config 動作になる
CURSOR_CONFIG_ISOLATED="$WORK_DIR/cursor-config"
mkdir -p "$CURSOR_CONFIG_ISOLATED"
REAL_CURSOR_CONFIG_DIR="${CURSOR_CONFIG_DIR:-}"
if [ -z "$REAL_CURSOR_CONFIG_DIR" ]; then
  if [ -n "${XDG_CONFIG_HOME:-}" ]; then
    REAL_CURSOR_CONFIG_DIR="$XDG_CONFIG_HOME/cursor"
  else
    REAL_CURSOR_CONFIG_DIR="$HOME/.cursor"
  fi
fi
[ -f "$REAL_CURSOR_CONFIG_DIR/cli-config.json" ] && cp "$REAL_CURSOR_CONFIG_DIR/cli-config.json" "$CURSOR_CONFIG_ISOLATED/cli-config.json"

if [ "$SESSION_MODE" = "resumable" ]; then
  # cursor-agent の create-chat は起動途中で racy に停止し、stdin を /dev/null に
  # 固定していても無応答の孤児プロセスとして残り得る。正常応答は 2〜5 秒で返るため、
  # timeout で打ち切って最大 3 回まで再試行する
  create_chat_attempt=0
  while [ "$create_chat_attempt" -lt 3 ] && [ -z "$CURSOR_CHAT_ID" ]; do
    create_chat_attempt=$((create_chat_attempt + 1))
    create_chat_status=0
    create_chat_output="$(CURSOR_CONFIG_DIR="$CURSOR_CONFIG_ISOLATED" TMPDIR="$WORK_DIR/tmp" timeout -k 5 45 agent create-chat </dev/null 2>>"$WORK_DIR/cursor-create-chat.stderr")" || create_chat_status=$?
    # 失敗時の stdout は診断出力の可能性があり chat id として信用できない
    if [ "$create_chat_status" -eq 0 ]; then
      CURSOR_CHAT_ID="$(printf '%s\n' "$create_chat_output" | tail -n 1 | tr -d '\r')"
    fi
  done
  if [ -z "$CURSOR_CHAT_ID" ]; then
    delegate_observe_resume_unavailable "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "Cursor create-chat failed" || true
    finish_without_child 5 "ERROR: agent create-chat failed."
  fi
fi

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

agent_args=(
  -p
  --trust
  --force
  --model "$MODEL"
)

if [ -n "$CURSOR_CHAT_ID" ]; then
  agent_args+=(--resume "$CURSOR_CHAT_ID")
fi

agent_args+=("$PROMPT")

cleanup() {
  if [ -n "${child_pid:-}" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

cd "$REPO_ROOT"
CURSOR_CONFIG_DIR="$CURSOR_CONFIG_ISOLATED" TMPDIR="$WORK_DIR/tmp" agent "${agent_args[@]}" </dev/null \
  >"$stdout_capture" 2>"$stderr_capture" &
child_pid=$!

if delegate_observe_wait_with_heartbeat "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$child_pid" "$stdout_capture" "$stderr_capture"; then
  child_status=0
else
  child_status=$?
fi

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

measured_usage="$(delegate_observe_usage_from_capture "$stdout_capture" "$ORIGINAL_MODEL" "$backend" cursor_json || true)"
delegate_observe_record_usage "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "$REQUEST_FILE" "$RESPONSE_FILE" cursor_json "$measured_usage" || true

if [ "$SESSION_MODE" = "resumable" ]; then
  if [ "$child_status" -eq 0 ] && [ "$response_allows_resume" -eq 1 ]; then
    delegate_observe_backend_session_update "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "$CURSOR_CHAT_ID" cursor_create_chat resumable "" || true
  else
    delegate_observe_resume_unavailable "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "Cursor run did not complete successfully" || true
  fi
elif [ "$SESSION_MODE" = "followup" ]; then
  if [ "$child_status" -eq 0 ] && [ "$response_allows_resume" -eq 1 ]; then
    delegate_observe_backend_session_update "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "$CURSOR_CHAT_ID" cursor_create_chat resumable "" || true
  else
    delegate_observe_resume_unavailable "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "Cursor follow-up did not complete successfully" || true
  fi
fi
record_run_context

printf '%s\n' "$RESPONSE_FILE"
exit "$response_status"
