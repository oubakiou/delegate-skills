#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/check-md2idx.sh
# 各 delegate-* skill の scripts/check-md2idx.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# md2idx の前提条件チェック（fail-closed）
# `npx md2idx` が実行不可なら exit 3（前提条件不足）でユーザーに通知して終了する。
# 成功時は npx キャッシュが温まり、後続（Codex sandbox 内含む）でオフライン実行しやすくなる。

if ! command -v npx >/dev/null 2>&1; then
  echo "ERROR: npx が見つかりません。Node.js (npx) をインストールしてください。" >&2
  exit 3
fi

if ! npx --yes md2idx --help >/dev/null 2>&1; then
  echo "ERROR: 'npx md2idx' を実行できません。ネットワーク接続または md2idx のインストールを確認してください。" >&2
  exit 3
fi
