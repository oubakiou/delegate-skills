#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/delegate-codex.sh
# 各 delegate-* skill の scripts/delegate-codex.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# gpt-* モデル指定時の Codex 子プロセス起動ラッパ
# 起動骨格は guarded-webfetch-codex/scripts/quarantine-fetch-codex.sh を流用する。
# Usage: delegate-codex.sh <model> <task_type> <request_file> <response_file>
# stdout: response_file のパスのみ（本文は親 context に入れない）

if [ $# -lt 4 ]; then
  echo "Usage: $0 <model> <task_type> <request_file> <response_file>" >&2
  exit 2
fi

MODEL="$1"
TASK_TYPE="$2"
REQUEST_FILE="$3"
RESPONSE_FILE="$4"

if ! command -v codex >/dev/null 2>&1; then
  echo "ERROR: codex CLI が見つかりません。" >&2
  exit 3
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# 既定の作業ディレクトリは mktemp に委ねる（TMPDIR、無ければ /tmp）。DELEGATE_WORK_DIR で上書き可
WORK_DIR="${DELEGATE_WORK_DIR:-$(mktemp -d --tmpdir delegate_codex_XXXXX)}"
mkdir -p "$WORK_DIR/tmp"

# 実 $CODEX_HOME を汚さない disposable home を作り、ログイン維持のため auth.json だけ持ち込む
CODEX_HOME_ISOLATED="$WORK_DIR/codex-home"
mkdir -p "$CODEX_HOME_ISOLATED"
REAL_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
[ -f "$REAL_CODEX_HOME/auth.json" ] && cp "$REAL_CODEX_HOME/auth.json" "$CODEX_HOME_ISOLATED/auth.json"

LAST_MSG="$WORK_DIR/codex-last-message.txt"
REPORT_FILE="$(mktemp --tmpdir="$WORK_DIR" "$(basename "$RESPONSE_FILE" .json)_report_XXXXX" --suffix=.md)"

# Codex 子は自身の session id を prompt 内から素直に取得できないため、ラッパが
# response_file のペアトークン（main 事前確保の一意トークン）から responder_session_id を導出して渡す。
RESPONDER_SESSION_ID="codex:${MODEL}:$(basename "$RESPONSE_FILE" .json)"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

write_companion_markdown() {
  # JSON が protocol の正本で、Markdown は人間の監査・デバッグ用の派生物に留める。
  (jq -r '.sections | join("\n\n")' "$1" >"${1%.json}.md") >/dev/null 2>&1 || true
}

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

# --ignore-rules は付けない: AGENTS.md を読ませて規約遵守させる
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
