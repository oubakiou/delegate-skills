#!/bin/bash
# コミット済み shared/dist/delegate-cli.mjs が shared/src からの再ビルドと
# byte 一致することを検証する (fail-closed)。ズレていたら `npm run build` を促す。
set -euo pipefail

cd "$(dirname "$0")/.."

# 固定パスだと同一 worktree での並行実行が互いの出力を消して誤失敗するため、実行ごとに確保する
out_dir=$(mktemp -d .temp/build-check.XXXXXX)
trap 'rm -rf "$out_dir"' EXIT

DELEGATE_CLI_OUT_DIR="$out_dir" npx --no-install vp build --config vite.cli.config.ts --logLevel error

if ! cmp -s "$out_dir/delegate-cli.mjs" shared/dist/delegate-cli.mjs; then
  echo "build:check: shared/dist/delegate-cli.mjs is stale (run \`npm run build\` and commit the result)" >&2
  exit 1
fi

echo "build:check: shared/dist/delegate-cli.mjs matches a clean rebuild"
