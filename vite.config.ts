export default {
  fmt: {
    // ビルド成果物 (shared/dist/) とその配布コピー (skills/*/scripts/*.mjs) は
    // 整形しない。整形すると再ビルド byte 比較・sync-shared のドリフト検知が壊れる。
    ignorePatterns: ['shared/dist/', 'skills/*/scripts/*.mjs'],
    semi: false,
    singleQuote: true,
    trailingComma: 'es5',
  },
  lint: {
    categories: {
      correctness: 'error',
      perf: 'error',
      restriction: 'error',
      style: 'error',
      suspicious: 'error',
    },
    // ビルド成果物とその配布コピーはチェック対象外。`vp build` / sync-shared で都度上書きされるため。
    ignorePatterns: ['dist/', 'skills/*/scripts/*.mjs'],
    options: { typeAware: true, typeCheck: true },
    rules: {
      'capitalized-comments': 'off',
      'no-array-reduce': 'off',
      'no-magic-numbers': 'off',
      'number-literal-case': 'off',
      'oxc/no-async-await': 'off',
      'oxc/no-rest-spread-properties': 'off',
      // import の並びは fmt (oxfmt sortImports) が所有する。lint の sort-imports は
      // member 構文順 (none→all→multiple→single) という別アルゴリズムで衝突するため off。
      'sort-imports': 'off',
      // protocol v1 の JSON (request/response envelope・metrics record) は bash(jq)
      // 実装との byte 互換のため挿入順が契約。自動整列は契約を壊すため off。
      'sort-keys': 'off',
      'unicorn/no-null': 'off',
    },
  },
  test: {
    // exclude を指定すると既定 (node_modules / .git のみ) を置換するため再掲する。
    // .temp/ は使い捨ての作業領域で、紛れ込んだテストファイルを対象にしない。
    exclude: ['**/node_modules/**', '**/.git/**', '**/.temp/**'],
    // shared/: 共有実装 (sanitize / codex-jsonl) の正本はここでテストする
    // skills/*/scripts/pipe-sanitize*.ts: 各 skill 固有のパイプ処理 (canonical)
    // skills/*/scripts/http-fetch*.ts: direct HTTP fetcher (canonical)
    // .claude/skills/ 側は gh skill install で配布される生成物のため、
    // 正本である skills/ 側を直接テスト対象にし、再インストール忘れによる
    // 回帰検出漏れを防ぐ
    // 各 skill の scripts/sanitize.ts / codex-jsonl.ts は shared/ から自動生成された
    // コピーのため、テストを重複実行しない
    includeSource: [
      'shared/**/*.ts',
      'scripts/sync-shared*.ts',
      'scripts/evaluate-cost-fixtures*.ts',
      'scripts/summarize-metrics*.ts',
      'skills/*/scripts/pipe-sanitize*.ts',
      'skills/*/scripts/merge-summary*.ts',
      'skills/*/scripts/http-fetch*.ts',
      '.claude/statusline.ts',
      '.codex/hooks/**/*.ts',
    ],
  },
}
