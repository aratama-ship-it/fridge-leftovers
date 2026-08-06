# D1 migrations

既存の共有データを残したまま、番号順に1回ずつ適用する。

端末名・最終変更時刻を公開する場合は、Workerより先に次を実行する。

```bash
cd "/Users/arata/Library/Mobile Documents/com~apple~CloudDocs/claude code files/apps/life-app/fridge-leftovers/worker"
npx wrangler d1 execute fridge-leftovers --remote --file=./migrations/0002_change_attribution.sql
npx wrangler deploy
```

`schema.sql` は新規データベース用の完成形なので、既存データベースへ再実行しない。
