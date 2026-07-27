# 二人で1つの冷蔵庫を共有する（Supabase同期）セットアップ手順

作成日: 2026-07-27 / 対象: 冷蔵庫アプリの世帯共有

**Supabaseプロジェクトの作成は本人の手作業が必要**（Claudeはアカウントを作れない）。
作成して「Project URL」と「anon public key」を教えてくれれば、Claudeがアプリへ組み込む。

土台は [ルーティンノートのβ1設計](../routine-debugger/SUPABASE_SETUP.md) を流用している。
違うのは**持ち主が「人」ではなく「世帯」**であることと、**競合の扱い**（後述）。

---

## 0. 何を作るのか

- 同棲している二人が、**同じ1つの冷蔵庫**を別々のスマホから見て、書き換える
- **端末側が主体（ローカルファースト）**。圏外でも今までどおり動き、つながった時に同期する
- 招待コードを相手へ渡して、同じ世帯に入ってもらう

## 1. 何を共有し、何を共有しないか

冷蔵庫は共有物だが、アプリの一部は**その人だけのもの**。全部を共有すると使いにくくなる。

| データ | 共有 | 理由 |
|---|---|---|
| 在庫（冷蔵庫の中身） | **する** | これが共有したいもの本体 |
| 買い物リスト | **する** | どちらが買っても消える必要がある |
| 調理履歴 | **する** | 相手が作ったぶんも在庫に効く |
| 棚の数 | **する** | 冷蔵庫そのものの形 |
| 設定（栄養表示・見終わった売り場・「あとで」を押した日） | しない | 見え方の好みと、その人の進み具合 |
| 最近追加した食材 | しない | その端末での操作履歴 |
| 「今日使いたい食材」 | しない | いま料理を選んでいる人の文脈 |

## 2. 競合したらどうするか（★ルーティンノートと違うところ）

ルーティンノートは**記録**なので、競合したらどちらも捨てず競合コピーを作る。
冷蔵庫の在庫で同じことをすると**卵が2行になる**ので、そのままは使えない。

冷蔵庫での決まりごと:

- **在庫の数量が競合したら、少ないほうを採る。** 在庫を多く見積もると「材料あり」と出て
  買い物に行かず、帰ってから足りないと分かる。少なく見積もれば、余分に買うだけで済む。
  方針書の「迷ったら少なめに見積もる」（`UNIT_CONVERSIONS` のコメント）と同じ考え方
- **「使い切った」は必ず勝つ。** 片方が使い切ったと言っているなら、無いものとして扱う
- **確信度は低いほうを採る**（確認済み < 推定 < 不明）。片方が実物を見ていないなら、
  合わせて未確認として扱い、次に作るときまた聞く
- **買い物リストは足し合わせる。** 消したものは消えたまま（同じものを二度買わない）
- **調理履歴は追記だけ**なので競合しない

在庫の1品ごとに1行を持つので、**別々の食材をいじっている限り競合は起きない**。
競合するのは「二人が同じ食材を同時に触ったとき」だけ。

## 3. プロジェクトを作る（本人の作業）

1. https://supabase.com/ にサインアップ（GitHubアカウントでよい。ルーティンノートで
   作ったアカウントがあれば、それを使ってプロジェクトだけ追加する）
2. **New project**
   - Name: `fridge-leftovers`（任意）
   - Database Password: 自動生成でよい。**パスワードマネージャに保存する**
   - Region: **Northeast Asia (Tokyo)**
   - Plan: **Free**
3. 作成完了まで2〜3分待つ
4. **Project Settings → API** の「Project URL」と「anon public」キーを控える

> ⚠️ 無料プランは、**1週間まったくアクセスが無いとプロジェクトが一時停止**する。
> 二人で毎日使うなら止まらないが、旅行などで長く空けたら管理画面から再開する。

> anon key は公開されても問題ない鍵（アプリに埋め込む前提のもの）。
> 実際の保護は下の行レベルセキュリティが行う。**Database Password と service_role キーは
> アプリに入れない・人に見せない。**

## 4. メール確認の設定

**Authentication → Providers → Email** で

- Enable Email provider: ON
- Confirm email: **ON**（本人のメールアドレスであることを確かめてから使わせる）

## 5. SQL（丸ごと貼り付け）

左メニュー **SQL Editor → New query** に貼って Run。
「Success. No rows returned」と出れば成功。

```sql
-- ============================================================
-- 冷蔵庫アプリ 世帯共有スキーマ
-- 方式: サーバーrevision付き楽観的並行制御。持ち主は「世帯」
-- ============================================================

-- ---- 世帯とメンバー ----------------------------------------
create table if not exists public.households (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default 'わたしたちの冷蔵庫',
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  joined_at    timestamptz not null default now(),
  primary key (household_id, user_id)
);

create index if not exists household_members_user_idx
  on public.household_members (user_id);

-- 招待コード。相手へ口頭やLINEで渡す短い文字列
create table if not exists public.household_invites (
  code         text primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  created_by   uuid not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '7 days'),
  used_at      timestamptz,
  used_by      uuid references auth.users(id)
);

-- いま自分が入っている世帯。このアプリでは1人1世帯にする
create or replace function public.my_household() returns uuid
language sql stable security definer set search_path = public as $$
  select household_id from public.household_members
   where user_id = auth.uid() limit 1;
$$;

-- ---- 同期する実体 ------------------------------------------
create sequence if not exists public.entities_change_seq;

create table if not exists public.entities (
  household_id   uuid        not null references public.households(id) on delete cascade,
  kind           text        not null check (kind in ('item','shopping','cooking','shelves')),
  id             text        not null,
  body           jsonb       not null,
  entity_version bigint      not null default 1,
  change_seq     bigint      not null default nextval('public.entities_change_seq'),
  deleted_at     timestamptz,                    -- 削除は墓石化(消さずに印を付ける)
  updated_at     timestamptz not null default now(),
  updated_by     uuid references auth.users(id),
  primary key (household_id, kind, id)
);

create index if not exists entities_pull_idx
  on public.entities (household_id, change_seq);

-- 追加でも更新でも必ず通し番号を進める(更新を取りこぼさないため)
create or replace function public.bump_change_seq() returns trigger
language plpgsql as $$
begin
  new.change_seq := nextval('public.entities_change_seq');
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists entities_bump on public.entities;
create trigger entities_bump before insert or update on public.entities
  for each row execute function public.bump_change_seq();

-- 同じ変更を二重に適用しないための記録(通信の再送があっても安全にする)
create table if not exists public.applied_mutations (
  household_id uuid        not null references public.households(id) on delete cascade,
  mutation_id  text        not null,
  result       jsonb       not null,
  applied_at   timestamptz not null default now(),
  primary key (household_id, mutation_id)
);

-- ---- 世帯を用意する（初回サインイン時に呼ぶ） ---------------
create or replace function public.ensure_household() returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_id   uuid;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  select household_id into v_id from public.household_members
   where user_id = v_user limit 1;
  if found then return v_id; end if;
  insert into public.households default values returning id into v_id;
  insert into public.household_members (household_id, user_id) values (v_id, v_user);
  return v_id;
end $$;

-- ---- 招待コードを作る --------------------------------------
create or replace function public.create_invite() returns text
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_home uuid;
  v_code text;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  v_home := public.ensure_household();
  -- 紛らわしい文字(0/O/1/I)を避けた8文字
  v_code := translate(upper(substr(md5(gen_random_uuid()::text), 1, 8)),
                      '01', 'GH');
  insert into public.household_invites (code, household_id, created_by)
  values (v_code, v_home, v_user);
  return v_code;
end $$;

-- ---- 招待コードで世帯へ入る --------------------------------
-- ★すでに自分の冷蔵庫を持っている人が入ると、そちらが取り残される。
--   黙って捨てないよう、既に世帯にいる場合は p_leave_current を明示させる。
create or replace function public.join_household(
  p_code          text,
  p_leave_current boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_user   uuid := auth.uid();
  v_invite public.household_invites%rowtype;
  v_home   uuid;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;

  select * into v_invite from public.household_invites
   where code = upper(trim(p_code))
     and used_at is null
     and expires_at > now()
   for update;
  if not found then raise exception 'invite_invalid'; end if;

  select household_id into v_home from public.household_members
   where user_id = v_user limit 1;

  if found and v_home <> v_invite.household_id then
    if not p_leave_current then
      raise exception 'already_in_household';
    end if;
    delete from public.household_members
     where user_id = v_user and household_id = v_home;
  end if;

  insert into public.household_members (household_id, user_id)
  values (v_invite.household_id, v_user)
  on conflict do nothing;

  update public.household_invites
     set used_at = now(), used_by = v_user
   where code = v_invite.code;

  return v_invite.household_id;
end $$;

-- ============================================================
-- 変更を適用する本体。
-- 端末が「自分が見ていた版(base_version)」を申告し、一致したときだけ適用する。
-- 一致しなければ上書きせず conflict を返し、端末側で決着を付けさせる
-- （在庫は「少ないほうを採る」。この文書の 2. を見ること）
-- ============================================================
create or replace function public.apply_mutation(
  p_mutation_id  text,
  p_kind         text,
  p_id           text,
  p_body         jsonb,
  p_base_version bigint,
  p_deleted      boolean default false
) returns jsonb
language plpgsql security invoker as $$
declare
  v_home uuid := public.my_household();
  v_cur  public.entities%rowtype;
  v_prev jsonb;
  v_out  jsonb;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if v_home is null then raise exception 'no_household'; end if;

  select result into v_prev from public.applied_mutations
   where household_id = v_home and mutation_id = p_mutation_id;
  if found then return v_prev; end if;

  select * into v_cur from public.entities
   where household_id = v_home and kind = p_kind and id = p_id
   for update;

  if not found then
    if coalesce(p_base_version, 0) <> 0 then
      v_out := jsonb_build_object('status', 'conflict', 'server', null);
    else
      insert into public.entities (household_id, kind, id, body, entity_version, deleted_at)
      values (v_home, p_kind, p_id, p_body, 1,
              case when p_deleted then now() else null end)
      returning * into v_cur;
      v_out := jsonb_build_object('status', 'applied',
                 'version', v_cur.entity_version, 'change_seq', v_cur.change_seq);
    end if;

  elsif v_cur.entity_version <> coalesce(p_base_version, -1) then
    v_out := jsonb_build_object('status', 'conflict', 'server', to_jsonb(v_cur));

  else
    update public.entities
       set body           = p_body,
           entity_version = v_cur.entity_version + 1,
           deleted_at     = case when p_deleted then coalesce(v_cur.deleted_at, now()) else null end
     where household_id = v_home and kind = p_kind and id = p_id
     returning * into v_cur;
    v_out := jsonb_build_object('status', 'applied',
               'version', v_cur.entity_version, 'change_seq', v_cur.change_seq);
  end if;

  insert into public.applied_mutations (household_id, mutation_id, result)
  values (v_home, p_mutation_id, v_out);

  return v_out;
end $$;

-- ============================================================
-- 行レベルセキュリティ: 自分が入っている世帯の行だけ読める・書ける
-- ============================================================
alter table public.households         enable row level security;
alter table public.household_members  enable row level security;
alter table public.household_invites  enable row level security;
alter table public.entities           enable row level security;
alter table public.applied_mutations  enable row level security;

drop policy if exists households_mine on public.households;
create policy households_mine on public.households
  for select to authenticated
  using (id in (select household_id from public.household_members where user_id = auth.uid()));

drop policy if exists members_mine on public.household_members;
create policy members_mine on public.household_members
  for select to authenticated
  using (household_id in (select household_id from public.household_members where user_id = auth.uid()));

-- 招待は作った本人だけが見られる（コードでの参加は join_household 経由）
drop policy if exists invites_mine on public.household_invites;
create policy invites_mine on public.household_invites
  for select to authenticated
  using (created_by = auth.uid());

drop policy if exists entities_household on public.entities;
create policy entities_household on public.entities
  for all to authenticated
  using (household_id in (select household_id from public.household_members where user_id = auth.uid()))
  with check (household_id in (select household_id from public.household_members where user_id = auth.uid()));

drop policy if exists mutations_household on public.applied_mutations;
create policy mutations_household on public.applied_mutations
  for all to authenticated
  using (household_id in (select household_id from public.household_members where user_id = auth.uid()))
  with check (household_id in (select household_id from public.household_members where user_id = auth.uid()));
```

## 6. 動作を確かめる（SQLを流したあと）

SQL Editor で次を実行し、エラーが出ないことを見る。

```sql
select public.ensure_household();   -- 世帯ができる（管理画面からだと未認証で失敗してよい）
select * from public.entities;      -- 0行
```

管理画面からは認証されていないため `not_authenticated` が出るのが正しい。
本当の確認はアプリ側から行う。

---

## 実装の順序（Claude側）

1. ~~**書き出し・読み込み**~~（2026-07-27 実装済み。設定画面の「データの持ち出し」）
2. **在庫を1品1行として扱えるようにする**（いまは配列を丸ごと保存している）。
   各実体に `version` と「まだ送っていない印」を持たせる
3. サインイン画面（メール＋パスワード、確認メール）
4. 同期の往復（差分の取得 → 競合の決着 → 送信）
5. 招待コードの発行と参加
6. 画面の文言を直す（「この端末のブラウザ内だけに保存されます」は共有時に嘘になる）

1と2はサーバーが無くても作れて、単体で意味がある（バックアップと機種変更）。
3以降は Project URL と anon key をもらってから。
