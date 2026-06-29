#!/usr/bin/env bash
set -euo pipefail

# delegate-x-research の現在の Grok CLI 子プロセス起動ラッパ。
# Usage: delegate-x-research-grok.sh <model> <request_file> <response_file>
# stdout: response_file のパスのみ（本文は親 context に入れない）

if [ $# -lt 3 ]; then
  echo "Usage: $0 <model> <request_file> <response_file>" >&2
  exit 2
fi

MODEL="$1"
REQUEST_FILE="$2"
RESPONSE_FILE="$3"

if ! command -v grok >/dev/null 2>&1; then
  echo "ERROR: grok CLI が見つかりません。" >&2
  exit 3
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
WORK_DIR="${DELEGATE_WORK_DIR:-$(mktemp -d --tmpdir delegate_grok_x_XXXXX)}"
mkdir -p "$WORK_DIR/tmp"

LAST_MSG="$WORK_DIR/grok-last-message.txt"
REPORT_FILE="$(mktemp --tmpdir="$WORK_DIR" "$(basename "$RESPONSE_FILE" .json)_report_XXXXX" --suffix=.md)"
RESPONDER_SESSION_ID="grok:${MODEL}:$(basename "$RESPONSE_FILE" .json)"

write_companion_markdown() {
  (jq -r '.sections | join("\n\n")' "$1" >"${1%.json}.md") >/dev/null 2>&1 || true
}

PROMPT=$(cat <<PROMPT_EOF
あなたは delegate-skills の x.com 調査ワーカー（task_type=xresearch）です。protocol v1 に従ってください。

1. リクエストを読む: ${REQUEST_FILE}
   まず \`jq -r .index "${REQUEST_FILE}"\` で目次を読み、必要な section だけ \`jq -r '.sections[N]' "${REQUEST_FILE}"\` で取得する。
2. リクエストの Scope に従い、利用可能な X / x.com 調査能力と web search を使って調査する。AGENTS.md / CLAUDE.md の規約に従うこと。
3. 投稿URL、投稿者、投稿日時、確認時刻、検索語を Sources / Method に残す。事実、推測、未確認情報を混ぜない。
4. 非公開・削除済み・ログイン不足・検索結果の偏り・時点依存がある場合は、Limitations または Blockers に書く。
5. 作業報告を Markdown("${REPORT_FILE}") に書き、レスポンスを生成する:
   \`npx md2idx "${REPORT_FILE}" | jq --arg s "<status>" --arg sid "${RESPONDER_SESSION_ID}" '{protocol_version: 1, type: "response", status: \$s, responder_session_id: \$sid} + .' > "${RESPONSE_FILE}"\`
   status は completed | partial | failed | needs_input のいずれか。report.md の見出しは
   Summary / Findings / Sources / Method / Limitations / Blockers。
6. 最終応答は status の一語のみ（本文は ${RESPONSE_FILE} に書く）。リポジトリ root に report.md を作らない。
PROMPT_EOF
)

TMPDIR="$WORK_DIR/tmp" \
  grok -p "$PROMPT" \
  -m "$MODEL" \
  --cwd "$REPO_ROOT" \
  --no-memory \
  --sandbox "${GROK_DELEGATE_SANDBOX:-danger-full-access}" \
  --permission-mode "${GROK_DELEGATE_PERMISSION_MODE:-bypassPermissions}" \
  --output-format plain >"$LAST_MSG" 2>"$WORK_DIR/grok.stderr" || {
    cat "$WORK_DIR/grok.stderr" >&2
    exit 1
  }

if [ ! -s "$RESPONSE_FILE" ]; then
  echo "ERROR: 子 Grok が response_file を生成しませんでした: $RESPONSE_FILE" >&2
  exit 1
fi

write_companion_markdown "$RESPONSE_FILE"

printf '%s\n' "$RESPONSE_FILE"
