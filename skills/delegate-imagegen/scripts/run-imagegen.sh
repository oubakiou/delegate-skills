#!/bin/sh
# 正本: skills/delegate-imagegen/scripts/run-imagegen.sh
# 実装は TS (shared/src/run-oneshot.ts) にあり、本ファイルは delegate-cli への exec shim。
# 契約 (argv / stdin / stdout の単一 JSON / exit code 透過 / observe_file の stderr 先出し) は
# SKILL.md が依存する公開契約。

command -v node >/dev/null 2>&1 || {
  echo "ERROR: node が見つかりません。Node.js 24+ をインストールしてください。" >&2
  exit 3
}

dir="$(dirname "$0")"
exec node "$dir/delegate-cli.mjs" run-imagegen "$@"
