# 看板（GitHub 連動）

GitHub の PR・看板（JSON）・最近の動きを、スマホで日本語で見るための PWA です。

- 正本は GitHub です。この画面はデータを持たず、開くたびに GitHub から読みます。
- できること：PR の一覧と中身（CI・レビュー・行への指摘）、コメント、マージ（2回押し）、看板 JSON の表示、最近の動き。
- トークンは、使う端末のブラウザの中（localStorage）にだけ保存します。送り先は api.github.com だけです（index.html の Content-Security-Policy で制限）。
- このリポジトリには画面のプログラムだけが入っています。トークンや業務データは入っていません。

## 必要なトークン（Fine-grained personal access token）

対象のリポジトリだけを選び、次の権限を付けます。

- Contents：Read and write（マージに使用）
- Pull requests：Read and write
- Issues：Read and write（PR へのコメントに使用）
- Commit statuses：Read-only

## 同梱しているライブラリ

- marked 15.0.12（MIT）— vendor/marked.LICENSE.md
- DOMPurify 3.2.6（Apache-2.0 / MPL-2.0）— vendor/dompurify.LICENSE

作成：Claude（claude-opus-5-5、claude.ai の Claude Code セッション）2026-10-13。ユーザーの依頼「GitHub 連動の表示アプリを PWA で」と承認「1A」に基づく。
