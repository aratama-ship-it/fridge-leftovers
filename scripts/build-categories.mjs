// 食材カテゴリー（大分類10＋小分類34）の台本。
// 全idがちょうど1回割り当てられていることを検証してから app.js 用の定数を書き出す。
// 品目を足し引きしたらこれを実行し、/tmp/categories.js を app.js へ差し替える。
//   node scripts/build-categories.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// URL の pathname はスペースが %20 になるため fileURLToPath を通す
const ROOT = fileURLToPath(new URL("..", import.meta.url));

// --- 現在アプリに登録済みのid ---
const app = readFileSync(`${ROOT}/app.js`, "utf8");
const rulesStart = app.indexOf("const RECEIPT_RULES =");
const rulesEnd = app.indexOf("\nconst ILLUSTRATED_INGREDIENT_CATEGORIES", rulesStart);
const registered = new Set(
  [...app.slice(rulesStart, rulesEnd).matchAll(/id: "([a-z0-9-]+)"/g)].map((m) => m[1])
);
registered.add("rice"); // ごはんはレシート認識の対象外だが食材として存在する

// --- 拡張予定のid ---
const expansion = readFileSync(`${ROOT}/scripts/expansion-items.mjs`, "utf8");
const planned = new Set(
  [...expansion.matchAll(/\["([a-z0-9-]+)", "[^"]+", "[^"]+", "[^"]+", "[^"]*", "[^"]+"\]/g)].map((m) => m[1])
);

const all = new Set([...registered, ...planned]);

// --- 大分類10 → 小分類 ---
const CATEGORIES = [
  {
    id: "vegetables", name: "野菜・きのこ", note: "葉物・根菜・果菜・きのこ・薬味",
    representatives: ["cabbage", "carrot", "tomato"],
    groups: [
      ["葉物・茎", ["cabbage", "chinese-cabbage", "lettuce", "sunny-lettuce", "salad-greens", "baby-leaf",
        "spinach", "komatsuna", "bok-choy", "mizuna", "shungiku", "moroheiya", "water-spinach", "nanohana",
        "rucola", "watercress", "celery", "asparagus", "broccoli", "cauliflower", "brussels-sprouts",
        "green-onion", "green-onion-small", "garlic-chives", "bean-sprouts", "pea-sprouts", "kaiware",
        "broccoli-sprout", "fuki", "cut-vegetables"]],
      ["根菜・いも", ["carrot", "onion", "red-onion", "potato", "sweet-potato", "taro", "yam", "radish",
        "turnip", "radish-red", "burdock", "lotus-root", "boiled-bamboo"]],
      ["果菜・豆", ["tomato", "cherry-tomato", "cucumber", "eggplant", "bell-pepper", "paprika", "shishito",
        "pumpkin", "zucchini", "winter-melon", "bitter-melon", "okra", "corn", "young-corn", "green-beans",
        "snow-peas", "snap-peas", "edamame", "broad-beans", "green-peas", "avocado"]],
      ["きのこ", ["mushroom", "shiitake", "enoki", "maitake", "shimeji-white", "eringi", "mushroom-button", "nameko"]],
      ["香味・薬味", ["garlic", "ginger", "new-ginger", "shiso", "myoga", "mitsuba", "parsley", "basil",
        "coriander", "yuzu"]]
    ]
  },
  {
    id: "fruit", name: "果物", note: "定番・柑橘・ベリー",
    representatives: ["banana", "apple"],
    groups: [
      ["定番", ["banana", "apple", "mandarin", "strawberry", "grape", "pear", "western-pear", "peach",
        "persimmon", "kiwi", "melon", "watermelon", "pineapple", "mango", "loquat", "plum", "cherry",
        "fig", "chestnut", "ume"]],
      ["柑橘", ["orange", "grapefruit", "lemon", "lime", "hassaku"]],
      ["ベリー・ドライ", ["blueberry", "raspberry", "raisin", "prune"]]
    ]
  },
  {
    id: "meat", name: "肉", note: "豚・鶏・牛・ひき肉・加工肉",
    representatives: ["pork", "chicken", "beef"],
    groups: [
      ["豚", ["pork", "pork-belly", "pork-loin", "pork-shoulder", "spare-ribs"]],
      ["鶏", ["chicken", "chicken-thigh", "chicken-tender", "chicken-wing", "chicken-wing-tip",
        "chicken-skin", "chicken-liver", "gizzard"]],
      ["牛", ["beef", "beef-steak", "beef-tongue", "beef-tendon", "horumon"]],
      ["ひき肉", ["ground-meat", "pork-mince", "chicken-mince"]],
      ["加工肉", ["bacon", "bacon-block", "ham", "sausage", "prosciutto", "salami", "char-siu", "roast-beef"]],
      ["その他", ["duck", "lamb"]]
    ]
  },
  {
    id: "seafood", name: "魚介", note: "魚・貝・練り物・魚卵",
    representatives: ["salmon", "mackerel", "shrimp"],
    groups: [
      ["魚", ["salmon", "mackerel", "yellowtail", "cod", "saury", "horse-mackerel", "sardine",
        "tuna-sashimi", "bonito-fresh", "swordfish", "flatfish", "sea-bream", "spanish-mackerel",
        "atka-mackerel", "shishamo", "eel", "conger-eel", "dried-aji", "shime-saba"]],
      ["貝・えび・いか・たこ", ["shrimp", "sweet-shrimp", "squid", "octopus", "clam", "freshwater-clam",
        "hamaguri", "scallop", "oyster", "crab"]],
      ["練り物", ["chikuwa", "kamaboko", "hanpen", "satsumaage", "kanikama", "fish-sausage"]],
      ["魚卵・魚加工", ["tuna", "cod-roe", "mentaiko", "ikura", "kazunoko", "shirako", "uni",
        "salmon-flake", "whitebait", "chirimen", "ika-shiokara"]]
    ]
  },
  {
    id: "protein", name: "卵・乳・大豆", note: "卵・乳製品・豆腐",
    representatives: ["eggs", "milk", "tofu"],
    groups: [
      ["卵", ["eggs", "quail-egg", "onsen-egg", "tamago-tofu"]],
      ["乳製品", ["milk", "yogurt", "cheese", "sliced-cheese", "pizza-cheese", "cream-cheese", "mozzarella",
        "powdered-cheese", "camembert", "blue-cheese", "cottage-cheese", "butter", "margarine",
        "fresh-cream", "sour-cream", "condensed-milk"]],
      ["豆腐・大豆製品", ["tofu", "grilled-tofu", "thick-fried-tofu", "fried-tofu", "ganmodoki",
        "koya-tofu", "yuba", "okara", "natto", "soy-milk", "miso"]]
    ]
  },
  {
    id: "staples", name: "主食・粉", note: "米・パン・麺・皮・粉",
    representatives: ["rice", "bread", "udon"],
    groups: [
      ["米・パン", ["rice", "rice-raw", "mochi-rice", "brown-rice", "mochi", "bread", "butter-roll",
        "french-bread", "croissant", "bagel", "english-muffin", "rye-bread", "naan", "tortilla"]],
      ["麺", ["pasta", "fresh-pasta", "penne", "macaroni", "udon", "soba", "somen", "kishimen",
        "yakisoba-noodles", "chinese-noodles", "bifun", "pho-noodles"]],
      ["皮", ["gyoza-wrapper", "wonton-wrapper", "spring-roll-wrapper", "pie-sheet"]],
      ["粉", ["flour", "bread-flour", "potato-starch", "corn-starch", "tempura-flour", "okonomiyaki-flour",
        "pancake-mix", "shiratamako", "buckwheat-flour", "breadcrumbs", "tenkasu"]],
      ["シリアル・雑穀", ["oatmeal", "granola", "corn-flakes", "barley", "couscous"]]
    ]
  },
  {
    id: "dry", name: "乾物・海藻・豆", note: "海藻・乾物・豆・ナッツ",
    representatives: ["wakame", "sesame"],
    groups: [
      ["海藻", ["wakame", "kombu", "tororo-kombu", "nori", "aonori", "hijiki", "mozuku", "mekabu", "shio-kombu"]],
      ["乾物", ["bonito", "dried-sardine", "dried-shiitake", "dried-radish", "kikurage", "sakura-shrimp",
        "dried-shrimp", "dried-tomato", "kanten", "gelatin", "fu", "glass-noodles", "sesame"]],
      ["豆", ["dried-soybeans", "azuki", "chickpeas", "lentils"]],
      ["ナッツ", ["almond", "walnut", "cashew"]]
    ]
  },
  {
    id: "processed", name: "缶詰・加工", note: "缶詰・瓶詰・こんにゃく",
    representatives: ["canned-tomato", "konnyaku"],
    groups: [
      ["缶詰", ["canned-tomato", "canned-corn", "canned-mackerel", "canned-sardine", "canned-peach",
        "coconut-milk", "corned-beef", "spam"]],
      ["瓶詰・その他", ["tomato-puree", "nametake", "nori-tsukudani", "peanut-butter", "anko",
        "mixed-beans", "boiled-soybeans", "menma", "zasai", "konnyaku", "shirataki", "furikake"]]
    ]
  },
  {
    id: "pickles", name: "漬物", note: "キムチ・梅干し",
    representatives: ["kimchi", "umeboshi"],
    groups: [
      ["漬物", ["kimchi", "takuan", "umeboshi", "nozawana", "beni-shoga", "rakkyo", "fukujinzuke"]]
    ]
  },
  {
    id: "frozen", name: "冷凍", note: "冷凍野菜・シーフード",
    representatives: ["mixed-vegetables", "frozen-potato"],
    groups: [
      ["冷凍", ["mixed-vegetables", "frozen-seafood-mix", "frozen-potato"]]
    ]
  }
];

// --- 検証 ---
const seen = new Map();
const errors = [];
for (const category of CATEGORIES) {
  for (const [groupName, ids] of category.groups) {
    for (const id of ids) {
      if (seen.has(id)) errors.push(`重複: ${id}（${seen.get(id)} と ${category.name}/${groupName}）`);
      else seen.set(id, `${category.name}/${groupName}`);
      if (!all.has(id)) errors.push(`未知のid: ${id}（${category.name}/${groupName}）`);
    }
  }
  for (const id of category.representatives) {
    if (!seen.has(id) && !all.has(id)) errors.push(`代表アイコンのidが不明: ${id}`);
  }
}
const missing = [...all].filter((id) => !seen.has(id));
missing.forEach((id) => errors.push(`未割り当て: ${id}`));

console.log("=== 検証 ===");
console.log(`登録済み ${registered.size} / 拡張予定 ${planned.size} / 全体 ${all.size}`);
console.log(`割り当て済み ${seen.size} / 大分類 ${CATEGORIES.length} / 小分類 ${CATEGORIES.reduce((n, c) => n + c.groups.length, 0)}`);
if (errors.length) {
  console.log(`\n★${errors.length}件の問題`);
  errors.slice(0, 40).forEach((e) => console.log("  " + e));
  process.exitCode = 1;
} else {
  console.log("問題なし（全idがちょうど1回割り当てられている）");
}

// --- 現時点で表示される件数（イラストがあるものだけ）---
const illStart = app.indexOf("const INGREDIENT_ILLUSTRATIONS =");
const illEnd = app.indexOf("\nconst RECEIPT_RULES", illStart);
const illustrated = new Set(
  [...app.slice(illStart, illEnd).matchAll(/^\s*"?([a-z0-9-]+)"?:\s*\[/gm)].map((m) => m[1])
);
console.log("\n=== 大分類ごとの件数（いま表示 / 全体）===");
for (const c of CATEGORIES) {
  const ids = c.groups.flatMap(([, list]) => list);
  const now = ids.filter((id) => illustrated.has(id)).length;
  console.log(`  ${c.name.padEnd(14, "　")} ${String(now).padStart(2)} / ${String(ids.length).padStart(3)}`);
}

// --- 出力 ---
if (!errors.length) {
  const body = CATEGORIES.map((c) => {
    const groups = c.groups.map(([name, ids]) =>
      `      {\n        name: ${JSON.stringify(name)},\n        items: [${ids.map((id) => JSON.stringify(id)).join(", ")}]\n      }`
    ).join(",\n");
    return `  {\n    id: ${JSON.stringify(c.id)},\n    name: ${JSON.stringify(c.name)},\n    note: ${JSON.stringify(c.note)},\n    representatives: [${c.representatives.map((id) => JSON.stringify(id)).join(", ")}],\n    groups: [\n${groups}\n    ]\n  }`;
  }).join(",\n");
  const out = `const ILLUSTRATED_INGREDIENT_CATEGORIES = [\n${body}\n];\n`;
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/categories.js", out);
  console.log("\n/tmp/categories.js へ書き出しました（" + out.split("\n").length + "行）");
}
