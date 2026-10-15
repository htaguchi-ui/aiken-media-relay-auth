# aiken-media-relay-auth

A.I.KEN メディア生成（ChatGPT から使う MCP 中継サーバー）のログイン・許可画面です。
ChatGPT の接続ボタンから開かれ、Google アカウントでログインして接続を許可します。

- `consent.html`：Supabase Auth の OAuth 2.1 サーバーの許可画面（authorization path）
- ページ内の Supabase キーは公開用（publishable）で、秘密情報は含みません。
