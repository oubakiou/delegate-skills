#!/usr/bin/env bash
set -euo pipefail

# delegate-x-research の現在の Grok CLI 子プロセス起動ラッパ。
# Usage: delegate-x-research-grok.sh <model> <request_file> <response_file> [run_dir] [observe_file]
# stdout: response_file のパスのみ（本文は親 context に入れない）

if [ $# -lt 3 ]; then
  echo "Usage: $0 <model> <request_file> <response_file> [run_dir] [observe_file]" >&2
  exit 2
fi

MODEL="$1"
REQUEST_FILE="$2"
RESPONSE_FILE="$3"
RUN_DIR="${4:-${RESPONSE_FILE%_res.json}}"
OBSERVE_FILE="${5:-${RESPONSE_FILE%_res.json}_observe.json}"
WORK_DIR="$RUN_DIR"
mkdir -p "$WORK_DIR/tmp"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/observe-json.sh"

backend="grok"
dispatch_pid="$$"
stdout_capture="$WORK_DIR/worker-stdout.capture"
stderr_capture="$WORK_DIR/worker-stderr.capture"
: >"$stdout_capture"
: >"$stderr_capture"

if [ ! -s "$OBSERVE_FILE" ]; then
  delegate_observe_init "$OBSERVE_FILE" "$WORK_DIR" xresearch "$MODEL" "$backend" "$REQUEST_FILE" "$RESPONSE_FILE" ""
fi

finish_without_child() {
  local exit_code="$1"
  local message="$2"

  printf '%s\n' "$message" >"$stderr_capture"
  delegate_observe_write_failed_response "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$RESPONSE_FILE" "$exit_code" || true

  local response_present=false
  if [ -s "$RESPONSE_FILE" ]; then
    response_present=true
    delegate_observe_write_companion_markdown "$RESPONSE_FILE"
  else
    delegate_observe_response_missing "$OBSERVE_FILE" "$WORK_DIR"
  fi

  delegate_observe_heartbeat "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$dispatch_pid" "$stdout_capture" "$stderr_capture"
  delegate_observe_import_streams "$OBSERVE_FILE" "$WORK_DIR" "$stdout_capture" "$stderr_capture"
  delegate_observe_dispatch_end "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$dispatch_pid" "$exit_code" "$response_present"
  delegate_observe_append_dispatch_metrics "$OBSERVE_FILE" xresearch "$MODEL" "$backend" \
    "$(delegate_observe_elapsed_ms "$dispatch_start_ms")" "$exit_code" "$response_present" "$RESPONSE_FILE" || true
  printf '%s\n' "$RESPONSE_FILE"
  exit "$exit_code"
}

dispatch_start_ms="$(delegate_observe_monotonic_ms)"
delegate_observe_dispatch_start "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$dispatch_pid"

if ! command -v grok >/dev/null 2>&1; then
  finish_without_child 3 "ERROR: grok CLI が見つかりません。"
fi

available_grok_models() {
  grok models </dev/null 2>/dev/null | awk '/^[[:space:]]*[-*][[:space:]]+/ {print $2}'
}

grok_model_available() {
  available_grok_models | grep -Fx "$1" >/dev/null
}

if ! grok_model_available "$MODEL" && grok_model_available grok-build; then
  echo "WARN: Grok CLI model '$MODEL' is unavailable; falling back to 'grok-build'." >&2
  MODEL="grok-build"
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# 報告方式は起動前に確定する（grok は schema 強制の実測が未了のため report.md が既定。
# §docs/archive/delegate-latency-reduction.archive.md）
REPORT_MODE="$(delegate_observe_report_mode_for_backend grok)"
REPORT_FILE="$WORK_DIR/report.md"
RESPONDER_SESSION_ID="grok:${MODEL}:$(basename "$RESPONSE_FILE" .json)"

# request は初期 prompt へ埋め込み、read-request の初回往復を消す（gate 超過時は fallback）。
# grok CLI の stdin / --prompt-file は未実測のため prompt は argv で渡す。argv 経路は
# 単一引数上限（MAX_ARG_STRLEN）に収まる縮小 gate を適用する
request_inline=true
if ! request_step="$(delegate_observe_request_prompt_step "$REQUEST_FILE" "$script_dir" "$DELEGATE_REQUEST_ARGV_INLINE_MAX")"; then
  request_inline=false
fi

PROMPT=$(cat <<PROMPT_EOF
あなたは delegate-skills の x.com 調査ワーカー（task_type=xresearch）です。protocol v1 に従ってください。

${request_step}
2. リクエストの Scope に従い、利用可能な X / x.com 調査能力と web search を使って調査する。AGENTS.md / CLAUDE.md の規約に従うこと。
3. 投稿URL、投稿者、投稿日時、確認時刻、検索語を Sources / Method に残す。事実、推測、未確認情報を混ぜない。
4. 非公開・削除済み・ログイン不足・検索結果の偏り・時点依存がある場合は、Limitations または Blockers に書く。
5. 作業報告を front-matter 付き Markdown で "${REPORT_FILE}" に 1 回の書込で作る。ファイルの 1 行目から
   ---
   status: <completed | partial | failed | needs_input のいずれか>
   ---
   の front-matter を置き、その下に見出し Summary / Findings / Sources / Method / Limitations / Blockers の本文を書く。
   report は簡潔に書く: Summary は 5 行以内。Findings は重要なものに絞り、探索ログや検索結果の生貼りはしない。該当が無い見出しは省く。
   md2idx / jq によるレスポンス生成はしない（レスポンス生成は wrapper が行う）。リポジトリ root に report.md を作らない。
6. 最終応答は status の一語のみ。
PROMPT_EOF
)

grok_args=(
  --no-auto-update
  -p "$PROMPT"
  -m "$MODEL"
  --cwd "$REPO_ROOT"
  --no-memory
  --permission-mode "${GROK_DELEGATE_PERMISSION_MODE:-bypassPermissions}"
  --output-format plain
)

if [ -n "${GROK_DELEGATE_SANDBOX:-}" ]; then
  grok_args+=(--sandbox "$GROK_DELEGATE_SANDBOX")
fi

cleanup() {
  if [ -n "${child_pid:-}" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

TMPDIR="$WORK_DIR/tmp" \
  grok "${grok_args[@]}" </dev/null >"$stdout_capture" 2>"$stderr_capture" &
child_pid=$!

if delegate_observe_wait_with_heartbeat "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$child_pid" "$stdout_capture" "$stderr_capture" "$RESPONSE_FILE"; then
  child_status=0
else
  child_status=$?
fi

# report.md 方式: worker が書いた front-matter 付き report から wrapper が response を
# 組み立てる。欠落・不正は failed response へ倒す（後段の response 欠落分岐が処理する）
if [ "$REPORT_MODE" = report_md ] && [ ! -s "$RESPONSE_FILE" ]; then
  delegate_observe_build_response_from_report_md "$REPORT_FILE" "$RESPONDER_SESSION_ID" "$RESPONSE_FILE" "$WORK_DIR" || true
  if [ -s "$RESPONSE_FILE" ]; then
    DELEGATE_OBSERVE_REPORT_READY_MS="${DELEGATE_OBSERVE_REPORT_READY_MS:-$DELEGATE_OBSERVE_WAIT_TOTAL_MS}"
  fi
fi
delegate_observe_record_timing "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$stdout_capture" \
  "${DELEGATE_OBSERVE_WAIT_TOTAL_MS:-}" "${DELEGATE_OBSERVE_FIRST_USEFUL_MS:-}" "${DELEGATE_OBSERVE_REPORT_READY_MS:-}" || true

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

delegate_observe_record_effort "$OBSERVE_FILE" "$WORK_DIR" "" "" || true

response_present=false
if [ -s "$RESPONSE_FILE" ]; then
  response_present=true
else
  delegate_observe_response_missing "$OBSERVE_FILE" "$WORK_DIR"
fi
delegate_observe_dispatch_end "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$dispatch_pid" "$response_status" "$response_present"
delegate_observe_append_dispatch_metrics "$OBSERVE_FILE" xresearch "$MODEL" "$backend" \
  "$(delegate_observe_elapsed_ms "$dispatch_start_ms")" "$response_status" "$response_present" "$RESPONSE_FILE" || true

printf '%s\n' "$RESPONSE_FILE"
exit "$response_status"
