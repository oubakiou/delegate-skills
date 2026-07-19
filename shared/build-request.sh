#!/bin/sh
# 正本: shared/build-request.sh
# 実装は TS (shared/src/build-request.ts) にあり、本ファイルは delegate-cli への exec shim。
# 契約 (argv / stdin / stdout / exit code) は SKILL.md と呼び出し側スクリプトが依存する公開契約。

command -v node >/dev/null 2>&1 || {
  echo "ERROR: node が見つかりません。Node.js 24+ をインストールしてください。" >&2
  exit 3
}

dir="$(dirname "$0")"
# 配布形態では同ディレクトリ、リポジトリ正本 (shared/) では dist/ にバンドルがある
if [ -f "$dir/delegate-cli.mjs" ]; then
  exec node "$dir/delegate-cli.mjs" build-request "$@"
fi
exec node "$dir/dist/delegate-cli.mjs" build-request "$@"
