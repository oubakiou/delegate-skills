export default {
  fmt: {
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
    // ビルド成果物はチェック対象外。`vp build` で都度上書きされるため。
    ignorePatterns: ['dist/'],
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
      'unicorn/no-null': 'off',
    },
  },
  test: {
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
      'skills/*/scripts/pipe-sanitize*.ts',
      'skills/*/scripts/merge-summary*.ts',
      'skills/*/scripts/http-fetch*.ts',
      '.claude/statusline.ts',
      '.codex/hooks/**/*.ts',
    ],
  },
}
