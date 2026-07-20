#!/bin/sh
# 正本: skills/delegate-imagegen/scripts/delegate-imagegen-codex.sh
# 実装は TS (shared/src/wrapper-imagegen.ts) にあり、本ファイルは delegate-cli への exec shim。
# 契約 (argv / stdout の response_file パスのみ / exit code) は run-imagegen と SKILL.md が依存する公開契約。

command -v node >/dev/null 2>&1 || {
  echo "ERROR: node が見つかりません。Node.js 24+ をインストールしてください。" >&2
  exit 3
}

dir="$(dirname "$0")"
exec node "$dir/delegate-cli.mjs" wrapper imagegen "$@"
