#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/delegate-devin.sh
# 各 delegate-* skill の scripts/delegate-devin.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# swe-* モデル指定時の Devin CLI 子プロセス起動ラッパ
# 起動骨格は delegate-claude.sh と対称構造。
# Usage: delegate-devin.sh <model> <task_type> <request_file> <response_file>
# stdout: response_file のパスのみ（本文は親 context に入れない）

if [ $# -lt 4 ]; then
  echo "Usage: $0 <model> <task_type> <request_file> <response_file>" >&2
  exit 2
fi

MODEL="$1"
TASK_TYPE="$2"
REQUEST_FILE="$3"
RESPONSE_FILE="$4"

if ! command -v devin >/dev/null 2>&1; then
  echo "ERROR: devin CLI が見つかりません。" >&2
  exit 3
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# 既定の作業ディレクトリは mktemp に委ねる（TMPDIR、無ければ /tmp）。DELEGATE_WORK_DIR で上書き可
WORK_DIR="${DELEGATE_WORK_DIR:-$(mktemp -d --tmpdir delegate_devin_XXXXX)}"
mkdir -p "$WORK_DIR/tmp"

RESPONDER_SESSION_ID="devin:${MODEL}:$(basename "$RESPONSE_FILE" .json)"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

write_companion_markdown() {
  # JSON が protocol の正本で、Markdown は人間の監査・デバッグ用の派生物に留める。
  (jq -r '.sections | join("\n\n")' "$1" >"${1%.json}.md") >/dev/null 2>&1 || true
}

PROMPT=$(cat <<PROMPT_EOF
あなたは delegate-skills の隔離ワーカー（task_type=${TASK_TYPE}）です。protocol v1 に従ってください。

1. リクエストを読む: ${REQUEST_FILE}（JSON: protocol_version / type / task_type / model / task_type_chain / requester_session_id / index / sections）
   まず \`jq -r .index "${REQUEST_FILE}"\` で目次を読み、必要な section だけ \`jq -r '.sections[N]' "${REQUEST_FILE}"\` で取得する。
2. リクエストの指示に従って作業する。AGENTS.md / CLAUDE.md の規約に従うこと。
3. task_type_chain（${REQUEST_FILE} の .task_type_chain）に自種別を含む種別への再委譲は禁止。
4. 作業報告 Markdown を stdin で \`bash ${script_dir}/build-response.sh <status> ${RESPONDER_SESSION_ID} "${RESPONSE_FILE}"\` に渡して書く。status は completed | partial | failed | needs_input のいずれか。report の見出しは
   Summary / Changed files / Commands / Verification / Findings / Blockers / Error。
5. 最終応答は status の一語のみ（本文は ${RESPONSE_FILE} に書く）。
PROMPT_EOF
)

# --permission-mode dangerous は claude --dangerously-skip-permissions と同等（非対話のため permission prompt に応答できない）
# AGENTS.md は devin が自動で読む（無効化不可）ため --ignore-rules 相当は不要
devin_args=(
  -p "$PROMPT"
  --model "$MODEL"
  --permission-mode dangerous
)

cd "$REPO_ROOT"
TMPDIR="$WORK_DIR/tmp" devin "${devin_args[@]}" \
  >/dev/null 2>"$WORK_DIR/devin.stderr" || {
    cat "$WORK_DIR/devin.stderr" >&2
    exit 1
  }

if [ ! -s "$RESPONSE_FILE" ]; then
  echo "ERROR: 子 Devin が response_file を生成しませんでした: $RESPONSE_FILE" >&2
  exit 1
fi

write_companion_markdown "$RESPONSE_FILE"

printf '%s\n' "$RESPONSE_FILE"
