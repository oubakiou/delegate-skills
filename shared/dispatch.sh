#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/dispatch.sh
# 各 delegate-* skill の scripts/dispatch.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# モデル名プレフィックスによる実行系分岐（Codex / Devin / Cursor / Claude）。
# 分岐は決定論的なので main agent の推論に載せず、この 1 本の呼び出しに畳む。
# Usage: dispatch.sh <model> <task_type> <request_file> <response_file>
# stdout: 委譲先ラッパの stdout（response_file のパスのみ）
# exit: 委譲先ラッパの exit code をそのまま返す（2=引数エラー）

if [ $# -lt 4 ]; then
  echo "Usage: $0 <model> <task_type> <request_file> <response_file>" >&2
  exit 2
fi

model="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$model" in
  gpt*) backend="delegate-codex.sh" ;;
  swe* | devin-*) backend="delegate-devin.sh" ;;
  composer* | cursor-*) backend="delegate-cursor.sh" ;;
  *) backend="delegate-claude.sh" ;;
esac

exec bash "$script_dir/$backend" "$@"
