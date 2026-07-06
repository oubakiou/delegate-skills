#!/usr/bin/env bash
set -euo pipefail

# delegate-imagegen 専用の Codex 子プロセス起動ラッパ。
# Usage: delegate-imagegen-codex.sh <model> <request_file> <response_file> [run_dir] [observe_file]
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

backend="codex"
dispatch_pid="$$"
stdout_capture="$WORK_DIR/worker-stdout.capture"
stderr_capture="$WORK_DIR/worker-stderr.capture"
: >"$stdout_capture"
: >"$stderr_capture"

if [ ! -s "$OBSERVE_FILE" ]; then
  delegate_observe_init "$OBSERVE_FILE" "$WORK_DIR" imagegen "$MODEL" "$backend" "$REQUEST_FILE" "$RESPONSE_FILE" ""
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
  printf '%s\n' "$RESPONSE_FILE"
  exit "$exit_code"
}

delegate_observe_dispatch_start "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$dispatch_pid"

case "$MODEL" in
  gpt*) ;;
  *)
    finish_without_child 2 "ERROR: delegate-imagegen requires a gpt-* model for Codex execution: $MODEL"
    ;;
esac

if ! command -v codex >/dev/null 2>&1; then
  finish_without_child 3 "ERROR: codex CLI が見つかりません。"
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
OUTPUT_DIR="${DELEGATE_IMAGEGEN_OUTPUT_DIR:-delegate-imagegen-output}"
case "$OUTPUT_DIR" in
  /*) OUTPUT_PATH="$OUTPUT_DIR" ;;
  *) OUTPUT_PATH="$REPO_ROOT/$OUTPUT_DIR" ;;
esac
mkdir -p "$OUTPUT_PATH"

CODEX_HOME_ISOLATED="$WORK_DIR/codex-home"
mkdir -p "$CODEX_HOME_ISOLATED"
REAL_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
[ -f "$REAL_CODEX_HOME/auth.json" ] && cp "$REAL_CODEX_HOME/auth.json" "$CODEX_HOME_ISOLATED/auth.json"

LAST_MSG="$WORK_DIR/codex-last-message.txt"
REPORT_FILE="$(mktemp --tmpdir="$WORK_DIR" "$(basename "$RESPONSE_FILE" .json)_report_XXXXX" --suffix=.md)"
RESPONDER_SESSION_ID="codex:${MODEL}:$(basename "$RESPONSE_FILE" .json)"

PROMPT=$(cat <<PROMPT_EOF
あなたは delegate-skills の画像生成ワーカー（task_type=imagegen）です。protocol v1 に従ってください。

1. リクエストを読む: \`bash ${script_dir}/read-request.sh "${REQUEST_FILE}" all\` で全 section を 1 回で丸読みする（読み飛ばせる情報は無いので、段階読みで往復を増やさない）。
2. リクエストの指示に従い、利用可能な画像生成・画像編集 capability を使って成果物を生成する。AGENTS.md / CLAUDE.md の規約に従うこと。
3. 出力先がリクエストで明示されていない場合は、リポジトリ root からの相対パス \`${OUTPUT_DIR}/\` 配下に保存する。
4. 生成できない場合も、原因、試したパラメータ、必要な追加入力を report に残して failed または needs_input で response を生成する。
5. 作業報告を Markdown("${REPORT_FILE}") に書き、レスポンスを生成する:
   \`npx md2idx "${REPORT_FILE}" | jq --arg s "<status>" --arg sid "${RESPONDER_SESSION_ID}" '{protocol_version: 1, type: "response", status: \$s, responder_session_id: \$sid} + .' > "${RESPONSE_FILE}"\`
   status は completed | partial | failed | needs_input のいずれか。report.md の見出しは
   Summary / Generated files / Parameters / Verification / Blockers。
   report は簡潔に書く: Summary は 5 行以内。試行錯誤ログや生ログは貼らず、Parameters は最終採用値と重要な生成条件のみ。該当が無い見出しは省く。
6. 最終応答は status の一語のみ（本文は ${RESPONSE_FILE} に書く）。リポジトリ root に report.md を作らない。
PROMPT_EOF
)

cleanup() {
  if [ -n "${child_pid:-}" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

CODEX_HOME="$CODEX_HOME_ISOLATED" TMPDIR="$WORK_DIR/tmp" \
  codex exec \
  -m "$MODEL" \
  --skip-git-repo-check --ephemeral \
  --ignore-user-config \
  --sandbox "${CODEX_DELEGATE_SANDBOX:-danger-full-access}" \
  --output-last-message "$LAST_MSG" \
  -C "$REPO_ROOT" \
  "$PROMPT" >"$stdout_capture" 2>"$stderr_capture" &
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

response_present=false
if [ -s "$RESPONSE_FILE" ]; then
  response_present=true
else
  delegate_observe_response_missing "$OBSERVE_FILE" "$WORK_DIR"
fi
delegate_observe_dispatch_end "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$dispatch_pid" "$response_status" "$response_present"

# protocol status が failed の response は exit 0 でも失敗扱いとし、調査のため prune しない
response_protocol_status="$(jq -r '.status // empty' "$RESPONSE_FILE" 2>/dev/null || true)"
if [ "$response_status" -eq 0 ] && [ "$response_present" = true ] \
  && [ -n "$response_protocol_status" ] && [ "$response_protocol_status" != "failed" ]; then
  delegate_codex_home_prune "$CODEX_HOME_ISOLATED"
fi

printf '%s\n' "$RESPONSE_FILE"
exit "$response_status"
