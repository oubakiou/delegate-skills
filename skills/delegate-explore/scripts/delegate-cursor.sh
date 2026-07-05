#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/delegate-cursor.sh
# 各 delegate-* skill の scripts/delegate-cursor.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# composer-* / cursor-* モデル指定時の Cursor agent CLI 子プロセス起動ラッパ
# 起動骨格は delegate-claude.sh と対称構造。
# Usage: delegate-cursor.sh <model> <task_type> <request_file> <response_file> [run_dir] [observe_file]
#   <model> は composer-*（そのまま agent CLI に渡す）または cursor-*（プレフィックスを剥離して渡す）
# stdout: response_file のパスのみ（本文は親 context に入れない）

if [ $# -lt 4 ]; then
  echo "Usage: $0 <model> <task_type> <request_file> <response_file> [run_dir] [observe_file]" >&2
  exit 2
fi

MODEL="$1"
ORIGINAL_MODEL="$MODEL"
TASK_TYPE="$2"
REQUEST_FILE="$3"
RESPONSE_FILE="$4"
RUN_DIR="${5:-${RESPONSE_FILE%_res.json}}"
OBSERVE_FILE="${6:-${RESPONSE_FILE%_res.json}_observe.json}"

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
  printf '%s\n' "$RESPONSE_FILE"
  exit "$exit_code"
}

if ! command -v agent >/dev/null 2>&1; then
  finish_without_child 3 "ERROR: agent CLI が見つかりません。"
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

PROMPT=$(cat <<PROMPT_EOF
あなたは delegate-skills の隔離ワーカー（task_type=${TASK_TYPE}）です。protocol v1 に従ってください。

1. リクエストを読む: \`bash ${script_dir}/read-request.sh "${REQUEST_FILE}" all\` で全 section を 1 回で丸読みする（読み飛ばせる情報は無いので、段階読みで往復を増やさない）。
2. リクエストの指示に従って作業する。AGENTS.md / CLAUDE.md の規約に従うこと。${readonly_constraints}
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

agent_args+=("$PROMPT")

cleanup() {
  if [ -n "${child_pid:-}" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

cd "$REPO_ROOT"
TMPDIR="$WORK_DIR/tmp" agent "${agent_args[@]}" \
  >"$stdout_capture" 2>"$stderr_capture" &
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

measured_usage="$(delegate_observe_usage_from_capture "$stdout_capture" "$ORIGINAL_MODEL" "$backend" cursor_json || true)"
delegate_observe_record_usage "$OBSERVE_FILE" "$WORK_DIR" "$backend" "$ORIGINAL_MODEL" "$REQUEST_FILE" "$RESPONSE_FILE" cursor_json "$measured_usage" || true

printf '%s\n' "$RESPONSE_FILE"
exit "$response_status"
