# aiken-media-relay-auth

A.I.KEN メディア生成（ChatGPT から使う MCP 中継サーバー）のログイン・許可画面です。
ChatGPT の接続ボタンから開かれ、Google アカウントでログインして接続を許可します。

- `consent.html`：Supabase Auth の OAuth 2.1 サーバーの許可画面（authorization path）。名簿に登録された人だけが先へ進める
- `admin.html` / `admin.js` / `admin-lib.js`：管理コンソール（名簿の管理と使用量の確認。管理者だけが使える）
- ページ内の Supabase キーは公開用（publishable）で、秘密情報は含みません。
