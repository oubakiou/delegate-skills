// delegate-cli バンドル専用の vp build config。通常の vp コマンド (check / test) は
// ルートの vite.config.ts を使う。
// build:check が dist を汚さず再ビルドできるよう、出力先を env で差し替え可能にする。
const outDir = process.env.DELEGATE_CLI_OUT_DIR ?? 'shared/dist'

export default {
  build: {
    emptyOutDir: true,
    // dist は git コミット対象でレビュー・デバッグの対象になるため minify しない
    minify: false,
    outDir,
    rollupOptions: {
      external: [/^node:/],
      input: 'shared/src/main.ts',
      output: {
        entryFileNames: 'delegate-cli.mjs',
      },
    },
    ssr: true,
    target: 'node24',
  },
  // in-source test の分岐を dead-code として除去する
  define: { 'import.meta.vitest': 'undefined' },
  // SSR ビルドは npm 依存を既定で externalize するため、md2idx を内包するには必須
  ssr: { noExternal: true },
}
