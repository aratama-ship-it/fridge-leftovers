#!/usr/bin/env node
// レシートの行が、正しい食材へ当たるかを確かめる。
//
//   node scripts/check-receipt-matching.mjs
//
// RECEIPT_RULES は上から順に、最初に当たったルールを採る。細かい品目を総称より
// 前に置かないと事故る。**このテストで実際に見つけたもの**:
//   ・「めかぶ」が「かぶ」に取られていた
//   ・「あじの開き」が「あじ」に取られていた
//   ・「コンデンスミルク」が「牛乳」に取られていた（牛乳のパターンに「ミルク」がある）
//   ・「豚ひき肉」が総称の「ひき肉」に取られていた
//
// 食材を足すたびに、紛れそうな組み合わせをここへ足していく。

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const s = readFileSync(path.join(ROOT, "app.js"), "utf8");
const start = s.indexOf("const RECEIPT_RULES");
const seg = s.slice(s.indexOf("[", start), s.indexOf("\n];", start) + 2);
const rules = Function(`"use strict"; return (${seg});`)();

const CASES = [
  ["赤玉ねぎ", "red-onion"], ["玉ねぎ", "onion"],
  ["サニーレタス", "sunny-lettuce"], ["レタス", "lettuce"],
  ["小ねぎ", "green-onion-small"], ["長ねぎ", "green-onion"], ["万能ねぎ", "green-onion-small"],
  ["かいわれ大根", "kaiware"], ["大根", "radish"], ["切り干し大根", "dried-radish"],
  ["ラディッシュ", "radish-red"], ["二十日大根", "radish-red"],
  ["芽キャベツ", "brussels-sprouts"], ["キャベツ", "cabbage"], ["千切りキャベツ", "cut-vegetables"],
  ["白まいたけ", "shimeji-white"], ["まいたけ", "maitake"], ["しめじ", "mushroom"], ["ブナピー", "shimeji-white"],
  ["ブロッコリースプラウト", "broccoli-sprout"], ["ブロッコリー", "broccoli"],
  ["レーズン", "raisin"], ["干しぶどう", "raisin"], ["ぶどう", "grape"], ["シャインマスカット", "grape"],
  ["洋梨", "western-pear"], ["ラフランス", "western-pear"], ["幸水梨", "pear"],
  ["生ハム", "prosciutto"], ["ロースハム", "ham"],
  ["豚ひき肉", "pork-mince"], ["鶏ひき肉", "chicken-mince"], ["豚こま切れ", "pork"],
  ["豚肩ロース", "pork-shoulder"], ["豚ロース", "pork-loin"], ["牛肩ロース", "beef"],
  ["鶏レバー", "chicken-liver"], ["砂肝", "gizzard"],
  ["手羽先", "chicken-wing-tip"], ["手羽元", "chicken-wing"],
  ["明太子", "mentaiko"], ["たらこ", "cod-roe"],
  ["かつおたたき", "bonito-fresh"], ["かつお節", "bonito"],
  ["栗", "chestnut"], ["むき栗", "chestnut"], ["片栗粉", "potato-starch"],
  ["柿", "persimmon"], ["柿の種", null],
  ["ゆず", "yuzu"], ["柚子こしょう", null],
  ["ヤングコーン", "young-corn"], ["とうもろこし", "corn"], ["コーン缶", "canned-corn"],
  ["ししゃも", "shishamo"], ["かれい", "flatfish"], ["真鯛", "sea-bream"],
  ["めかじき", "swordfish"], ["うなぎ蒲焼", "eel"], ["ラムチョップ", "lamb"],
  ["チャーシュー", "char-siu"], ["サラミ", "salami"], ["スペアリブ", "spare-ribs"],
  ["アボカド", "avocado"], ["バジル", "basil"], ["みょうが", "myoga"], ["三つ葉", "mitsuba"],
  ["クレソン", "watercress"], ["ルッコラ", "rucola"], ["ベビーリーフ", "baby-leaf"],
  ["ししとう", "shishito"], ["グリーンピース", "green-peas"], ["絹さや", "snow-peas"],
  ["グレープフルーツ", "grapefruit"], ["ライム", "lime"], ["いちじく", "fig"],
  ["プルーン", "prune"], ["さくらんぼ", "cherry"], ["マンゴー", "mango"],
  ["カット野菜", "cut-vegetables"], ["いちご", "strawberry"], ["レモン", "lemon"],
  // シート18〜20
  ["あじの開き", "dried-aji"], ["あじ", "horse-mackerel"],
  ["魚肉ソーセージ", "fish-sausage"], ["ソーセージ", "sausage"],
  ["コンデンスミルク", "condensed-milk"], ["練乳", "condensed-milk"], ["牛乳", "milk"],
  ["うずらの卵", "quail-egg"], ["卵", "eggs"],
  ["卵豆腐", "tamago-tofu"], ["絹ごし豆腐", "tofu"],
  ["スライスチーズ", "sliced-cheese"], ["ピザ用チーズ", "pizza-cheese"],
  ["クリームチーズ", "cream-cheese"], ["モッツァレラチーズ", "mozzarella"],
  ["粉チーズ", "powdered-cheese"], ["チーズ", "cheese"],
  ["カニカマ", "kanikama"], ["ずわいがに", "crab"], ["かに", "crab"],
  ["玄米", "brown-rice"], ["もち米", "mochi-rice"], ["無洗米", "rice-raw"], ["コシヒカリ", "rice-raw"],
  ["米粉", null], ["米油", null], ["米酢", "vinegar"],
  ["ナン", "naan"], ["ナンプラー", null],
  ["ホットケーキミックス", "pancake-mix"], ["お好み焼き粉", "okonomiyaki-flour"],
  ["強力粉", "bread-flour"], ["白玉粉", "shiratamako"], ["小麦粉", "flour"], ["片栗粉", "potato-starch"],
  ["ちりめんじゃこ", "chirimen"], ["いくら", "ikura"], ["はまぐり", "hamaguri"],
  ["もずく", "mozuku"], ["めかぶ", "mekabu"], ["わかめ", "wakame"],
  ["いかの塩辛", "ika-shiokara"], ["するめいか", "squid"],
  ["がんもどき", "ganmodoki"], ["湯葉", "yuba"], ["おから", "okara"],
  ["マーガリン", "margarine"], ["クロワッサン", "croissant"], ["ベーグル", "bagel"],
  ["イングリッシュマフィン", "english-muffin"], ["トルティーヤ", "tortilla"],
  ["ペンネ", "penne"], ["ビーフン", "bifun"], ["きしめん", "kishimen"],
  ["スパゲッティ", "pasta"], ["食パン", "bread"],
  // シート21〜27
  ["生パスタ", "fresh-pasta"], ["パスタ", "pasta"],
  ["青のり", "aonori"], ["のりの佃煮", "nori-tsukudani"], ["焼のり", "nori"],
  ["桜えび", "sakura-shrimp"], ["干しエビ", "dried-shrimp"], ["甘えび", "sweet-shrimp"], ["えび", "shrimp"],
  ["とろろ昆布", "tororo-kombu"], ["塩昆布", "shio-kombu"], ["だし昆布", "kombu"],
  ["ドライトマト", "dried-tomato"], ["トマトピューレ", "tomato-puree"], ["トマト缶", "canned-tomato"], ["トマト", "tomato"],
  ["いわし缶", "canned-sardine"], ["いわし", "sardine"],
  ["ココナッツミルク", "coconut-milk"], ["牛乳", "milk"],
  ["ピーナッツバター", "peanut-butter"], ["バター", "butter"], ["バターロール", "butter-roll"],
  ["桃缶", "canned-peach"], ["白桃", "peach"],
  ["紅生姜", "beni-shoga"], ["新生姜", "new-ginger"], ["しょうが", "ginger"],
  ["ベーコンブロック", "bacon-block"], ["ベーコン", "bacon"],
  ["あなご", "conger-eel"], ["穴子の蒲焼", "conger-eel"], ["うなぎ蒲焼", "eel"],
  ["しめ鯖", "shime-saba"], ["さば", "mackerel"], ["さわら", "spanish-mackerel"],
  ["カマンベールチーズ", "camembert"], ["ブルーチーズ", "blue-cheese"],
  ["カッテージチーズ", "cottage-cheese"], ["サワークリーム", "sour-cream"], ["生クリーム", "fresh-cream"],
  ["温泉卵", "onsen-egg"], ["焼き豆腐", "grilled-tofu"], ["絹ごし豆腐", "tofu"],
  ["そば粉", "buckwheat-flour"], ["そば", "soba"],
  ["大豆水煮", "boiled-soybeans"], ["乾燥大豆", "dried-soybeans"], ["小豆", "azuki"],
  ["ふき", "fuki"], ["梅", "ume"], ["梅干し", "umeboshi"],
  ["すもも", "plum"], ["プルーン", "prune"],
  ["フォー", "pho-noodles"], ["フォーク", null],
  ["コーンスターチ", "corn-starch"], ["コーン缶", "canned-corn"], ["とうもろこし", "corn"],
  ["押し麦", "barley"], ["クスクス", "couscous"], ["ふりかけ", "furikake"],
  ["サラダ菜", "salad-greens"], ["サニーレタス", "sunny-lettuce"],
  ["スナップえんどう", "snap-peas"], ["絹さや", "snow-peas"], ["グリーンピース", "green-peas"],
  ["牛すじ", "beef-tendon"], ["牛タン", "beef-tongue"], ["牛こま", "beef"],
  ["鶏皮", "chicken-skin"], ["鶏むね肉", "chicken"],
  ["冷凍ポテト", "frozen-potato"], ["じゃがいも", "potato"],
  ["うに", "uni"], ["ライ麦パン", "rye-bread"], ["ワンタンの皮", "wonton-wrapper"], ["餃子の皮", "gyoza-wrapper"],
  // シート31〜32
  ["しょう油", "soy-sauce"], ["ごま油", "sesame-oil"], ["オリーブ油", "olive-oil"], ["サラダオイル", "salad-oil"],
  ["マヨネーズ", "mayonnaise"], ["トマトケチャップ", "ketchup"], ["中濃ソース", "sauce"], ["ポン酢", "ponzu"],
  ["ゆずぽん", "ponzu"], ["めんつゆ", "mentsuyu"], ["そばつゆ", "mentsuyu"], ["そうめんつゆ", "mentsuyu"],
  ["だしの素", "dashi-powder"], ["コンソメキューブ", "consomme"], ["カレールウ", "curry-roux"],
  ["粗塩", "salt"], ["上白糖", "sugar"], ["穀物酢", "vinegar"], ["りんご酢", "vinegar"], ["本みりん", "mirin"],
  ["料理酒", "cooking-sake"], ["黒こしょう", "pepper"], ["蜂蜜", "honey"], ["いちごジャム", "jam"],
  ["カットトマト缶", "canned-tomato-cut"], ["パイナップル缶", "canned-pineapple"], ["ドライマンゴー", "dried-mango"], ["大豆ミート", "soy-meat"],
  ["ホールトマト", "canned-tomato"], ["パイナップル", "pineapple"], ["マンゴー", "mango"], ["乾燥大豆", "dried-soybeans"],
  ["出汁パック", "dashi-pack"], ["ミートソース", "meat-sauce"], ["ソース焼きそば", "yakisoba-noodles"], ["柚子こしょう", null]
];

// 商品ではない行（店名・合計など）を落とせているか。
// 実例：「seiyu蓮根店」の蓮根をレンコンとして拾ってしまった。
// 地名がそのまま食材名になることがあるので、行の選別も一緒に確かめる。
const take = (name) => {
  const at = s.indexOf(`const ${name} = `);
  if (at < 0) throw new Error(`${name} が見つかりません`);
  return s.slice(at, s.indexOf("\n", at));
};
const { ignoredLine, storeLine } = Function(
  `"use strict"; ${take("ignoredLine")} ${take("storeLine")} return { ignoredLine, storeLine };`
)();
const dropped = (line) => ignoredLine.test(line) || storeLine.test(line);

// 正規表現が正しくても、使われていなければ意味がない。
// （実際、この確認を入れる前は、選別を外しても気づけなかった）
const wiring = [
  "if (compactLine.length < 2 || ignoredLine.test(compactLine)) return;",
  "if (storeLine.test(compactLine)) return;"
];
for (const call of wiring) {
  if (!s.includes(call)) {
    console.log(`✗ 行の選別が使われていない: ${call}`);
    process.exit(1);
  }
}

const NOT_PRODUCT = [
  "seiyu蓮根店", "西友蓮根店", "イオン大根店", "マルエツ本店",
  "○○支店", "株式会社ほげ", "〒1234567", "合計1250", "お預り2000"
];
const PRODUCT = ["れんこん1袋", "大根1本", "レンコン水煮", "豚こま切れ100g", "白菜1/4"];

let ng = 0;
for (const line of NOT_PRODUCT) {
  if (!dropped(line)) {
    ng += 1;
    console.log(`✗ 商品でない行を落とせていない: ${line}`);
  }
}
for (const line of PRODUCT) {
  if (dropped(line)) {
    ng += 1;
    console.log(`✗ 商品の行を落としてしまう: ${line}`);
  }
}
for (const [line, expected] of CASES) {
  const hit = rules.find((rule) => rule.pattern.test(line));
  const got = hit ? hit.id : null;
  if (got !== expected) {
    ng += 1;
    console.log(`✗ ${line}: ${got ?? "該当なし"}（期待 ${expected ?? "該当なし"}）`);
  }
}
const total = CASES.length + NOT_PRODUCT.length + PRODUCT.length;
console.log(ng
  ? `\n★${ng}件がずれています（全${total}件）`
  : `レシート照合チェック: OK（照合${CASES.length}件・行の選別${NOT_PRODUCT.length + PRODUCT.length}件）`);
process.exit(ng ? 1 : 0);
