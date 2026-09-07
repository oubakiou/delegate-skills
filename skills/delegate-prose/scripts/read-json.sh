#!/bin/sh
# 正本: shared/read-json.sh
# 実装は TS (shared/src/read-json.ts) にあり、本ファイルは delegate-cli への exec shim。
# `jq -r <dotpath>` 相当の最小 JSON リーダ。json_file 省略時は stdin から読む。
# 契約 (argv / stdout / exit code) は SKILL.md が依存する公開契約。

command -v node >/dev/null 2>&1 || {
  echo "ERROR: node が見つかりません。Node.js 24+ をインストールしてください。" >&2
  exit 3
}

dir="$(dirname "$0")"
# 配布形態では同ディレクトリ、リポジトリ正本 (shared/) では dist/ にバンドルがある
if [ -f "$dir/delegate-cli.mjs" ]; then
  exec node "$dir/delegate-cli.mjs" read-json "$@"
fi
exec node "$dir/dist/delegate-cli.mjs" read-json "$@"
