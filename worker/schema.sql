-- 冷蔵庫アプリ 共有スキーマ（Cloudflare D1 / SQLite）
--
-- 認証は「冷蔵庫IDを知っていること」で代える。二人で使うだけなので
-- アカウントを作らない（→ CLOUDFLARE_SYNC.md の 0.）。

-- 冷蔵庫そのもの。seq は変更の通し番号で、この冷蔵庫の中だけで増える
create table if not exists fridges (
  id         text primary key,
  seq        integer not null default 0,
  created_at integer not null,
  touched_at integer not null
);

-- 同期する実体。食材1品・買い物1件・調理1回・棚の数が、それぞれ1行になる
create table if not exists entities (
  fridge_id  text    not null references fridges(id) on delete cascade,
  kind       text    not null check (kind in ('item','shopping','cooking','shelves')),
  id         text    not null,
  body       text,                      -- JSON文字列。削除したものは null
  version    integer not null default 1,
  change_seq integer not null,
  deleted_at integer,                    -- 削除は墓石化（消さずに印を付ける）
  updated_at integer not null,
  primary key (fridge_id, kind, id)
);

-- 「前回の続きから」を引くための索引
create index if not exists entities_pull
  on entities (fridge_id, change_seq);
