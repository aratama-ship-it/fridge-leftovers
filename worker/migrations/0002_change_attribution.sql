-- 既存の共有冷蔵庫へ、最終変更の端末と時刻を追加する。
-- 既存行は null のまま残し、APIでは updated_at を時刻の代わりに返す。
alter table entities add column changed_at integer;
alter table entities add column device_id text;
alter table entities add column device_name text;
