# CLAUDE.md

将棋（先手）対チェス（後手）の変則将棋をブラウザで遊ぶ静的サイト。ルールは将棋ったー「将棋対チェス」準拠（詳細は README.md）。

## 構成

- `index.html` / `style.css` … 画面。ビルド工程なし、ESモジュール不使用（`file://` でも動く）
- `src/rules.js` … ルールエンジン。グローバル `ShogiChess` を公開。UIから独立しており、jsc でも動く
- `src/app.js` … UI・対局進行・URL共有・localStorage（ホストの局面保存）
- `src/net.js` … PeerJS によるP2P通信（グローバル `SvcNet`）
- `tests/run.js` … エンジンのテスト
- `build.py` / `lock.html` … 公開用ビルド。アプリを1枚のHTMLに束ねて合言葉で暗号化し、`docs/index.html` を生成
- `docs/` … GitHub Pages の公開元（ここだけが公開される）。生成物なので直接編集しない

## 座標系（rules.js）

- `board[row][col]`。row 0 が盤の上端（後手チェスの最奥段＝将棋の一段目）、col 0 が左端（将棋の9筋）
- 先手（SENTE=0）は将棋側で下にいて上へ進む（forward = -1）。後手（GOTE=1）はチェス側
- 着手の文字列表現: `m` + from(row,col) + to(row,col) + 成り記号（`+` 成 / `=` 不成 / `qrbn` ポーン昇格）、打ちは `d` + 駒種 + to。例 `m6252`, `m7117+`, `dFU44`

## 開発

- 動作確認: `python3 -m http.server 8765` → http://localhost:8765 （`.claude/launch.json` の `static`）
- テスト: `/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc src/rules.js tests/run.js`
  - この環境に node/npm は無い。テストは jsc で動く plain script のまま保つこと
- 公開先: GitHub Pages（main ブランチの `docs/`）。アプリを変更したら `SITE_PASSWORD=合言葉 python3 build.py` で `docs/index.html` を再生成してからコミット・push する
  - 合言葉はリポジトリに書かない（README にも書かない）。ユーザーに確認すること
  - ロック版の確認: `.claude/launch.json` の `locked`（`python3 -m http.server 8766 --directory docs`）

## 方針

- ルール変更は `src/rules.js` に閉じ、UIは `legalMoves` の結果だけを使う
- 通信相手から受け取った着手は必ず `findLegal` で検証する（ホストが正）
