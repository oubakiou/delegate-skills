#!/usr/bin/env bash
set -euo pipefail

# 配布 tree の静的検査（docs/feature/typescript-migration.md Step 8）。
# TS 移行後、delegate-* skill の配布物（shim / SKILL.md）に `jq` コマンドや
# `npx md2idx` への参照が残っていないことを機械的に確認する（fail-closed）。
#
# 対象は commit 対象の正本 `skills/`（ここは hard fail）。ローカル install 成果物
# （.claude/skills/ / .agents/skills/、gitignore 済み）は存在すれば warning のみ
# （`gh skill install --force` での再インストールを促す。CI の fresh checkout には
# 無いのでスキップされる）。
# 生成バンドル delegate-cli.mjs は検査対象外: 内部シンボル名（jqCoalesce 等）を含むが
# jq コマンド起動ではない。read-json.sh は jq 代替の正規ツールなので許容する。
#
# guarded-* 等の非 delegate skill は別系統の正本で本移行のスコープ外（除外）。

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

delegate_skills=(
  delegate-explore
  delegate-implement
  delegate-chore
  delegate-review
  delegate-imagegen
  delegate-x-research
  delegate-htmldoc
)

# `jq` コマンド（単語境界）と md2idx への参照を .sh / .md から検出。
# read-json.sh は jq 代替の正規ツール自体（doc コメントに「jq -r 相当」を含む）なので
# ファイル単位で除外する（`grep -v read-json` の行単位除外は同一行併記で偽陰性になる）。
scan_tree() {
  local root="$1"
  local hits=""
  local skill dir found
  for skill in "${delegate_skills[@]}"; do
    dir="$repo_root/$root/$skill"
    [ -d "$dir" ] || continue
    found="$(grep -rnE '\bjq\b|md2idx' "$dir" --include='*.sh' --include='*.md' \
      --exclude='read-json.sh' 2>/dev/null || true)"
    [ -n "$found" ] && hits="${hits}${found}"$'\n'
  done
  printf '%s' "$hits"
}

canonical_hits="$(scan_tree skills)"
if [ -n "$canonical_hits" ]; then
  printf '%s' "$canonical_hits" >&2
  echo "ERROR: skills/ の delegate-* に jq / md2idx への参照が残っています（TS 移行で撤廃済みのはず）。" >&2
  exit 1
fi

# 正本 TS 実装が jq / md2idx CLI を子プロセスで呼び出していないことも検査する
# （shim / SKILL.md だけでなく、TS へ spawn('jq') 等を足しても runtime 依存が復活するため）。
# 許容: md2idx は npm library として import して in-process で使う（`from 'md2idx'` /
# md2idx() 呼び出し）。禁止: jq / md2idx を argv 先頭に取る spawn/exec。
ts_spawn_hits="$(grep -rnE "(spawn(Sync)?|execFile(Sync)?)\(['\"](jq|md2idx)['\"]" \
  "$repo_root/shared/src" --include='*.ts' 2>/dev/null || true)"
if [ -n "$ts_spawn_hits" ]; then
  printf '%s\n' "$ts_spawn_hits" >&2
  echo "ERROR: shared/src の TS が jq / md2idx を子プロセスで呼び出しています（in-process の md2idx library だけ許容）。" >&2
  exit 1
fi

for root in .claude/skills .agents/skills; do
  [ -d "$repo_root/$root" ] || continue
  install_hits="$(scan_tree "$root")"
  if [ -n "$install_hits" ]; then
    echo "WARN: $root のローカル install が古いです。'gh skill install . <skill> --from-local --force' で再インストールしてください。" >&2
  fi
done

echo "check-no-jq-md2idx: ok"
