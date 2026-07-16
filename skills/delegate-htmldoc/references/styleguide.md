# delegate-htmldoc スタイルガイド

`template.html` に content を流し込んで自己完結型の HTML ドキュメントを生成するためのルール。テンプレートの body は全 component の使用例を兼ねる。

## 不変条件

- `<style>` ブロックは固定資産。CSS の追加・変更・削除をしない（インライン style も使わない）
- JavaScript を含めない（`script` 要素・イベントハンドラ属性・`javascript:` URL の禁止）。インタラクティブな表現を求められたら、作らずに Blockers で報告する
- 外部 URL（CDN の CSS / JS / フォント / 画像）に依存しない。参照してよいのはインライン埋め込みした SVG と、出力ディレクトリ配下に同梱したアセットの相対パスのみ
- 図・画像の素材は request で渡されたファイルのみ使う。worker が素材を生成・加工・取得することはしない
- 文書構造は `wrap > hero + section(toc) + section* + section(history) + footer`。hero・footer・目次（toc）・経緯（history）は必ず 1 つずつ。目次は hero 直後、history は footer 直前に置く
- 経緯（時系列ログ・改訂履歴・「以前は〜だった」等の変更記述）は history セクションにだけ書く。他の section は常に最新の仕様・事実のみを記載する
- テンプレートに無い class・component を発明しない。表現が足りない場合は素の HTML 要素（p / ul / strong / a）で書く

## component 語彙

| component  | 用途                                                           | 使用回数の目安 |
| ---------- | -------------------------------------------------------------- | -------------- |
| hero       | タイトル・サブタイトル・meta リンク・badge                     | 必ず 1         |
| toc        | hero 直後の目次（`ol.toc`、各 section への anchor リンク）     | 必ず 1         |
| section    | 本文の基本単位（h2 + 段落・リスト・表）                        | 1 以上         |
| table      | 比較・一覧。状態セルは status-ok / status-pending / status-bad | 任意           |
| pill       | セル内の状態ラベル（ok / pending / bad）                       | table と併用   |
| badge      | hero 内のステータス表示（既定=緑 / neutral=青 / warn=黄）      | 任意           |
| conclusion | 結論・最重要メッセージの強調ボックス                           | 0〜1           |
| tasks      | 残課題・手順の順序付きリスト（`ol.tasks`）                     | 任意           |
| codeblock  | 複数行のコード・ログ・コマンド例（`pre > code`）               | 任意           |
| note       | セクション末尾の出典・脚注（`p.note`）                         | 任意           |
| figure     | 親から渡された図・画像の掲載（figcaption 付き）                | 任意           |
| history    | footer 直前の経緯記録（`ul.history`、時系列ログ・改訂履歴）    | 必ず 1         |
| footer     | 文書末尾の一行                                                 | 必ず 1         |

## 執筆ルール

- `<title>` は「タイトル — 補足」形式。hero の h1 と一致させる
- toc を除く各 section 要素に h2 と対応する id を付与し、目次（`ol.toc`）の anchor リンク先にする。目次には history セクションも含める（toc 自身はリンク対象にしない）
- history の項目は `time` 要素で日付を示し、古い順に並べる。日付が source から特定できない場合は `time` を省略し、記述順で時系列を保つ。source に経緯情報が無い場合は初版作成の 1 項目だけでよい
- 言語は request の指定に従う。指定がなければ日本語で書き、コード識別子・固有名詞は原文のまま `code` で示す
- 事実と推測を混ぜない。未確認事項は status-pending / pill pending で明示する
- 出典があるものは note か meta のリンクで示す
- SVG 素材はファイル内容を figure 内へインライン埋め込みする（単一ファイル性を保つ）
- ラスタ画像（PNG / JPEG 等）は出力 HTML と同じディレクトリ配下（例: `assets/`）へコピーし、相対パスで参照する。figure には必ず figcaption と img の alt を付ける
