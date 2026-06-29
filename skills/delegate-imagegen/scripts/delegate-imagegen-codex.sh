#!/usr/bin/env bash
set -euo pipefail

# delegate-imagegen 専用の Codex 子プロセス起動ラッパ。
# Usage: delegate-imagegen-codex.sh <model> <request_file> <response_file>
# stdout: response_file のパスのみ（本文は親 context に入れない）

if [ $# -lt 3 ]; then
  echo "Usage: $0 <model> <request_file> <response_file>" >&2
  exit 2
fi

MODEL="$1"
REQUEST_FILE="$2"
RESPONSE_FILE="$3"

case "$MODEL" in
  gpt*) ;;
  *)
    echo "ERROR: delegate-imagegen requires a gpt-* model for Codex execution: $MODEL" >&2
    exit 2
    ;;
esac

if ! command -v codex >/dev/null 2>&1; then
  echo "ERROR: codex CLI が見つかりません。" >&2
  exit 3
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
WORK_DIR="${DELEGATE_WORK_DIR:-$(mktemp -d --tmpdir delegate_imagegen_codex_XXXXX)}"
OUTPUT_DIR="${DELEGATE_IMAGEGEN_OUTPUT_DIR:-delegate-imagegen-output}"
case "$OUTPUT_DIR" in
  /*) OUTPUT_PATH="$OUTPUT_DIR" ;;
  *) OUTPUT_PATH="$REPO_ROOT/$OUTPUT_DIR" ;;
esac
mkdir -p "$WORK_DIR/tmp" "$OUTPUT_PATH"

CODEX_HOME_ISOLATED="$WORK_DIR/codex-home"
mkdir -p "$CODEX_HOME_ISOLATED"
REAL_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
[ -f "$REAL_CODEX_HOME/auth.json" ] && cp "$REAL_CODEX_HOME/auth.json" "$CODEX_HOME_ISOLATED/auth.json"

LAST_MSG="$WORK_DIR/codex-last-message.txt"
REPORT_FILE="$(mktemp --tmpdir="$WORK_DIR" "$(basename "$RESPONSE_FILE" .json)_report_XXXXX" --suffix=.md)"
RESPONDER_SESSION_ID="codex:${MODEL}:$(basename "$RESPONSE_FILE" .json)"

write_companion_markdown() {
  (jq -r '.sections | join("\n\n")' "$1" >"${1%.json}.md") >/dev/null 2>&1 || true
}

PROMPT=$(cat <<PROMPT_EOF
あなたは delegate-skills の画像生成ワーカー（task_type=imagegen）です。protocol v1 に従ってください。

1. リクエストを読む: ${REQUEST_FILE}
   まず \`jq -r .index "${REQUEST_FILE}"\` で目次を読み、必要な section だけ \`jq -r '.sections[N]' "${REQUEST_FILE}"\` で取得する。
2. リクエストの指示に従い、利用可能な画像生成・画像編集 capability を使って成果物を生成する。AGENTS.md / CLAUDE.md の規約に従うこと。
3. 出力先がリクエストで明示されていない場合は、リポジトリ root からの相対パス \`${OUTPUT_DIR}/\` 配下に保存する。
4. 生成できない場合も、原因、試したパラメータ、必要な追加入力を report に残して failed または needs_input で response を生成する。
5. 作業報告を Markdown("${REPORT_FILE}") に書き、レスポンスを生成する:
   \`npx md2idx "${REPORT_FILE}" | jq --arg s "<status>" --arg sid "${RESPONDER_SESSION_ID}" '{protocol_version: 1, type: "response", status: \$s, responder_session_id: \$sid} + .' > "${RESPONSE_FILE}"\`
   status は completed | partial | failed | needs_input のいずれか。report.md の見出しは
   Summary / Generated files / Parameters / Verification / Blockers。
6. 最終応答は status の一語のみ（本文は ${RESPONSE_FILE} に書く）。リポジトリ root に report.md を作らない。
PROMPT_EOF
)

CODEX_HOME="$CODEX_HOME_ISOLATED" TMPDIR="$WORK_DIR/tmp" \
  codex exec \
  -m "$MODEL" \
  --skip-git-repo-check --ephemeral \
  --ignore-user-config \
  --sandbox "${CODEX_DELEGATE_SANDBOX:-danger-full-access}" \
  --output-last-message "$LAST_MSG" \
  -C "$REPO_ROOT" \
  "$PROMPT" >/dev/null 2>"$WORK_DIR/codex.stderr" || {
    cat "$WORK_DIR/codex.stderr" >&2
    exit 1
  }

if [ ! -s "$RESPONSE_FILE" ]; then
  echo "ERROR: 子 Codex が response_file を生成しませんでした: $RESPONSE_FILE" >&2
  exit 1
fi

write_companion_markdown "$RESPONSE_FILE"

printf '%s\n' "$RESPONSE_FILE"
