// 冷蔵庫アプリの共有サーバー（Cloudflare Workers + D1）
//
// 設計は ../CLOUDFLARE_SYNC.md。要点だけ:
//
// ・認証は「冷蔵庫IDを知っていること」で代える。二人で使うだけなので
//   アカウントを作らない。IDは推測できない長さにする
// ・**サーバーは冷蔵庫の中身を解釈しない。** 食材の名前も数量も、ただのJSONと
//   して預かるだけ。レシピや判定はすべて端末側にある
// ・競合したときサーバーは「あなたが見ていた版と違う」と返すだけ。何を採るかは
//   アプリの都合（在庫は少ないほうを採る、など）なので端末側で決める

// 紛らわしい l/1/0/o を除いた32文字。ちょうど32なので、下の byte % 長さ に
// 偏りが出ない（33文字だと一部の文字がわずかに出やすくなる）
const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const ID_LENGTH = 22;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_CHANGES = 200;
const READ_PAGE_SIZE = 500;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS }
  });

const fail = (message, status = 400) => json({ error: message }, status);

function newFridgeId() {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return id;
}

const looksLikeId = (value) =>
  typeof value === "string"
  && value.length === ID_LENGTH
  && [...value].every((letter) => ID_ALPHABET.includes(letter));

async function createFridge(env) {
  const id = newFridgeId();
  const now = Date.now();
  await env.DB.prepare(
    "insert into fridges (id, seq, created_at, touched_at) values (?, 0, ?, ?)"
  ).bind(id, now, now).run();
  return json({ id });
}

async function readChanges(env, fridgeId, since) {
  // 1件多く読むことで、通し番号の欠番に影響されず次ページの有無を判定する。
  // entities は各IDの最新版だけを持つため、head.seq との差だけでは判断できない。
  const rows = await env.DB.prepare(
    `select kind, id, body, version, change_seq, deleted_at,
            changed_at, device_id, device_name, updated_at
       from entities
      where fridge_id = ? and change_seq > ?
      order by change_seq
      limit ?`
  ).bind(fridgeId, since, READ_PAGE_SIZE + 1).all();

  const head = await env.DB.prepare("select seq from fridges where id = ?")
    .bind(fridgeId).first();
  const available = rows.results || [];
  const hasMore = available.length > READ_PAGE_SIZE;
  const page = available.slice(0, READ_PAGE_SIZE);
  const lastSeq = Number(page.at(-1)?.change_seq) || Number(since) || 0;

  return json({
    // 続きがある間は「実際に返した最後の行」だけを既読にする。
    // 最終ページでは、同じIDの更新で生じた欠番も含めheadまで進めてよい。
    seq: hasMore ? lastSeq : (head?.seq ?? lastSeq),
    hasMore,
    changes: page.map((row) => ({
      kind: row.kind,
      id: row.id,
      body: row.body ? JSON.parse(row.body) : null,
      version: row.version,
      changeSeq: row.change_seq,
      deleted: Boolean(row.deleted_at),
      changedAt: new Date(row.changed_at || row.updated_at).toISOString(),
      changedBy: row.device_id || row.device_name
        ? { id: row.device_id || "", name: row.device_name || "" }
        : null,
      receivedAt: new Date(row.updated_at).toISOString()
    }))
  });
}

function changeAttribution(change, now) {
  const parsedAt = Date.parse(change?.changedAt);
  const source = change?.changedBy;
  const id = typeof source?.id === "string" ? source.id.trim().slice(0, 100) : "";
  const name = typeof source?.name === "string" ? source.name.trim().slice(0, 30) : "";
  return {
    changedAt: Number.isFinite(parsedAt) ? parsedAt : now,
    deviceId: id || null,
    deviceName: name || null
  };
}

// 1件を適用する。端末が申告した版と食い違えば、書き換えずにサーバー側を返す。
async function applyOne(env, fridgeId, change) {
  const { kind, id, body = null, baseVersion = 0, deleted = false } = change;
  if (!["item", "shopping", "cooking", "shelves"].includes(kind)) {
    return { kind, id, status: "rejected", reason: "kind" };
  }
  if (typeof id !== "string" || !id || id.length > 200) {
    return { kind, id, status: "rejected", reason: "id" };
  }

  const current = await env.DB.prepare(
    `select body, version, change_seq, deleted_at,
            changed_at, device_id, device_name, updated_at
       from entities where fridge_id = ? and kind = ? and id = ?`
  ).bind(fridgeId, kind, id).first();

  if (current && current.version !== baseVersion) {
    return {
      kind,
      id,
      status: "conflict",
      server: {
        body: current.body ? JSON.parse(current.body) : null,
        version: current.version,
        changeSeq: current.change_seq,
        deleted: Boolean(current.deleted_at),
        changedAt: new Date(current.changed_at || current.updated_at).toISOString(),
        changedBy: current.device_id || current.device_name
          ? { id: current.device_id || "", name: current.device_name || "" }
          : null,
        receivedAt: new Date(current.updated_at).toISOString()
      }
    };
  }
  if (!current && baseVersion) {
    // サーバーに無いのに版を申告している＝端末の想定とずれている
    return { kind, id, status: "conflict", server: null };
  }

  // 通し番号は冷蔵庫ごとに1つ。追加でも更新でも必ず進める
  const bumped = await env.DB.prepare(
    "update fridges set seq = seq + 1, touched_at = ? where id = ? returning seq"
  ).bind(Date.now(), fridgeId).first();
  const seq = bumped?.seq;
  if (!seq) return { kind, id, status: "rejected", reason: "fridge" };

  const now = Date.now();
  const attribution = changeAttribution(change, now);
  const text = deleted ? null : JSON.stringify(body);
  const version = (current?.version || 0) + 1;

  await env.DB.prepare(
    `insert into entities (
       fridge_id, kind, id, body, version, change_seq, deleted_at,
       changed_at, device_id, device_name, updated_at
     )
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (fridge_id, kind, id) do update set
       body = excluded.body,
       version = excluded.version,
       change_seq = excluded.change_seq,
       deleted_at = excluded.deleted_at,
       changed_at = excluded.changed_at,
       device_id = excluded.device_id,
       device_name = excluded.device_name,
       updated_at = excluded.updated_at`
  ).bind(
    fridgeId, kind, id, text, version, seq, deleted ? now : null,
    attribution.changedAt, attribution.deviceId, attribution.deviceName, now
  ).run();

  return {
    kind,
    id,
    status: "applied",
    version,
    changeSeq: seq,
    changedAt: new Date(attribution.changedAt).toISOString(),
    changedBy: attribution.deviceId || attribution.deviceName
      ? { id: attribution.deviceId || "", name: attribution.deviceName || "" }
      : null,
    receivedAt: new Date(now).toISOString()
  };
}

async function writeChanges(env, fridgeId, changes) {
  if (!Array.isArray(changes)) return fail("changes は配列で送ってください");
  if (changes.length > MAX_CHANGES) {
    return fail(`一度に送れるのは${MAX_CHANGES}件までです`, 413);
  }
  const results = [];
  for (const change of changes) {
    results.push(await applyOne(env, fridgeId, change));
  }
  const head = await env.DB.prepare("select seq from fridges where id = ?")
    .bind(fridgeId).first();
  return json({ seq: head?.seq ?? 0, results });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // POST /v1/fridges
    if (request.method === "POST" && parts.length === 2
      && parts[0] === "v1" && parts[1] === "fridges") {
      return createFridge(env);
    }

    // /v1/fridges/:id/changes
    if (parts.length === 4 && parts[0] === "v1" && parts[1] === "fridges"
      && parts[3] === "changes") {
      const fridgeId = parts[2];
      if (!looksLikeId(fridgeId)) return fail("冷蔵庫のIDが正しくありません", 404);

      const exists = await env.DB.prepare("select 1 from fridges where id = ?")
        .bind(fridgeId).first();
      if (!exists) return fail("その冷蔵庫はありません", 404);

      if (request.method === "GET") {
        const since = Number(url.searchParams.get("since") || 0);
        return readChanges(env, fridgeId, Number.isFinite(since) ? since : 0);
      }

      if (request.method === "POST") {
        const raw = await request.text();
        if (raw.length > MAX_BODY_BYTES) return fail("送る量が多すぎます", 413);
        let payload = null;
        try {
          payload = JSON.parse(raw);
        } catch {
          return fail("JSONとして読めませんでした");
        }
        return writeChanges(env, fridgeId, payload?.changes);
      }
    }

    return fail("そのURLはありません", 404);
  }
};
