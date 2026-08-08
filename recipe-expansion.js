// v0.17.0で追加するレシピデータ。app.jsより先に読み込む。
// 既存画面と同じ形式へ変換するため、入力は食材IDと数量を中心にコンパクトに保つ。
(() => {
  const INGREDIENTS = {
    rice: ["ごはん", "膳"], bread: ["食パン", "枚"], eggs: ["卵", "個"], tofu: ["豆腐", "個"],
    pork: ["豚こま", "g"], "pork-belly": ["豚バラ肉", "g"], "pork-loin": ["豚ロース", "g"], "pork-mince": ["豚ひき肉", "g"], "ground-meat": ["ひき肉", "g"],
    chicken: ["鶏むね肉", "g"], "chicken-thigh": ["鶏もも肉", "g"], "chicken-tender": ["鶏ささみ", "g"], beef: ["牛肉", "g"],
    salmon: ["鮭", "切れ"], mackerel: ["さば", "切れ"], yellowtail: ["ぶり", "切れ"], cod: ["たら", "切れ"], shrimp: ["えび", "g"],
    tuna: ["ツナ", "缶"], "canned-mackerel": ["サバ缶", "缶"], "canned-sardine": ["いわし缶", "缶"], whitebait: ["しらす", "パック"],
    cabbage: ["キャベツ", "g"], "chinese-cabbage": ["白菜", "g"], carrot: ["にんじん", "本"], onion: ["玉ねぎ", "個"], potato: ["じゃがいも", "個"],
    tomato: ["トマト", "個"], cucumber: ["きゅうり", "本"], eggplant: ["なす", "本"], spinach: ["ほうれん草", "袋"], "bell-pepper": ["ピーマン", "袋"],
    mushroom: ["しめじ", "株"], enoki: ["えのき", "袋"], broccoli: ["ブロッコリー", "個"], pumpkin: ["かぼちゃ", "g"], radish: ["大根", "本"],
    "green-onion": ["ねぎ", "本"], "green-onion-small": ["小ねぎ", "袋"], "garlic-chives": ["にら", "袋"], "bean-sprouts": ["もやし", "袋"], asparagus: ["アスパラガス", "袋"],
    burdock: ["ごぼう", "本"], "lotus-root": ["れんこん", "本"], "sweet-potato": ["さつまいも", "本"], corn: ["とうもろこし", "本"], okra: ["オクラ", "袋"], lettuce: ["レタス", "個"],
    udon: ["うどん", "袋"], soba: ["そば", "g"], somen: ["そうめん", "袋"], pasta: ["スパゲッティ", "g"],
    cheese: ["チーズ", "g"], milk: ["牛乳", "本"], butter: ["バター", "g"], yogurt: ["ヨーグルト", "個"], natto: ["納豆", "パック"], kimchi: ["キムチ", "袋"],
    sausage: ["ソーセージ", "袋"], bacon: ["ベーコン", "g"], ham: ["ハム", "パック"], chikuwa: ["ちくわ", "袋"], wakame: ["わかめ", "袋"], nori: ["のり", "袋"],
    "shio-kombu": ["塩昆布", "袋"], umeboshi: ["梅干し", "個"], avocado: ["アボカド", "個"], apple: ["りんご", "個"], clam: ["あさり", "袋"], "soy-milk": ["豆乳", "本"],
    ginger: ["しょうが", "個"], lemon: ["レモン", "個"], sesame: ["ごま", "袋"], shiso: ["大葉", "袋"]
  };

  const required = (id, quantity) => {
    const [name, unit] = INGREDIENTS[id];
    return { id, name, quantity, unit };
  };
  const optional = (id, quantity, benefit = "味と食感が広がる") => ({
    ...required(id, quantity), benefit
  });
  const STAPLES = new Set(["rice", "bread", "udon", "soba", "somen", "pasta"]);
  const RAW_MEAT_OR_FISH = new Set([
    "pork", "pork-belly", "pork-loin", "pork-mince", "ground-meat", "chicken", "chicken-thigh", "chicken-tender",
    "beef", "salmon", "mackerel", "yellowtail", "cod", "shrimp", "clam"
  ]);
  // 貝は「中心まで」が言葉として合わない。開いたかどうかが加熱の目安になる
  const SHELLFISH = new Set(["clam"]);

  function generatedSteps(method, recipe) {
    const names = recipe.required.map((item) => item.name).join("、");
    const heatedItems = recipe.required.filter((item) => RAW_MEAT_OR_FISH.has(item.id));
    const needsFullHeat = heatedItems.length > 0;
    const heatedNames = heatedItems.map((item) => item.name).join("・");
    const shellOnly = needsFullHeat && heatedItems.every((item) => SHELLFISH.has(item.id));
    // 各テンプレートが差し込む「火を通す」の言い回し
    const heatCore = shellOnly
      ? `${heatedNames}の殻が開くまで加熱し、開かないものは取り除く。`
      : `${heatedNames}の中心まで火を通す。`;
    const heatFinish = needsFullHeat
      ? (shellOnly
          ? `${heatedNames}の殻が開いたことを確認し、開かないものは取り除く。`
          : `${heatedNames}の中心まで火が通ったことを確認し、足りなければ追加加熱する。`)
      : recipe.required.some((item) => item.id === "eggs")
        ? "卵が好みの固さになるまで加熱し、全体を整える。"
        : "全体を混ぜて味をなじませ、器へ盛る。";
    const season = recipe.pantry || "塩・こしょう";
    const methods = {
      microwave: [
        `${names}を使いやすい大きさと分量に整え、耐熱容器へ重ねる。`,
        `${season}を加え、ふんわりラップをして電子レンジで加熱する。`,
        heatFinish
      ],
      mug: [
        `${names}を使いやすい大きさと分量に整え、大きめの耐熱マグへ入れる。`,
        `${season}と水を加え、ふんわりラップをして電子レンジで温める。`,
        heatFinish
      ],
      pan: [
        `${names}を使いやすい大きさと分量に整える。`,
        `フライパンに油を熱し、火の通りにくい材料から炒める。`,
        `${season}で味を整え、${needsFullHeat ? "中心まで十分に火を通す。" : "全体をさっと炒め合わせる。"}`
      ],
      simmer: [
        `${names}を使いやすい大きさと分量に整え、鍋へ入れる。`,
        `${season}と水を加え、具材がやわらかくなるまで煮る。`,
        heatFinish
      ],
      soup: [
        `${names}を使いやすい大きさと分量に整える。`,
        // 他の調理法と揃える。ここだけ heatFinish を使っておらず、生の肉・魚を
        // 使うスープ4件で「中心まで」の確認が抜けていた（2026-08-08の監査）
        `鍋へ水と材料を入れ、${needsFullHeat ? heatCore : "火が通るまで煮る。"}`,
        `${season}で味を整えて温かいうちに盛る。`
      ],
      bowl: [
        `${names}を整え、${needsFullHeat ? heatCore : "加熱が必要な具材を先に調理する。"}`,
        `温かいごはんを器へ盛り、具材を彩りよくのせる。`,
        `${season}で味を整え、全体を軽く混ぜながら食べる。`
      ],
      noodle: [
        `麺を袋の表示に合わせてゆでるか、電子レンジで温める。`,
        `${names}の具材を整え、${needsFullHeat ? heatCore : "必要なものは火を通す。"}`,
        `${season}で麺と具材を手早く和える。`
      ],
      toast: [
        `${names}の具材を使いやすい大きさと分量に整える。`,
        `食パンへ具材を均等に広げる。`,
        `トースターでパンの縁が色づくまで焼く。`
      ],
      salad: [
        `${names}を整え、${needsFullHeat ? heatCore : "加熱が必要な材料は先に火を通す。"}`,
        `水気と粗熱を取り、ボウルへ入れる。`,
        `${season}で和え、味をなじませる。`
      ],
      grill: [
        `${names}を使いやすい大きさと分量に整え、${season}で下味をつける。`,
        `フライパンまたはトースターで両面を焼く。`,
        heatFinish
      ],
      steam: [
        `${names}を使いやすい大きさと分量に整え、フライパンへ重ねる。`,
        `${season}と少量の水を加え、ふたをして蒸す。`,
        heatFinish
      ],
      bake: [
        `${names}を使いやすい大きさと分量に整え、耐熱皿へ並べる。`,
        `${season}を加え、トースターで表面が色づくまで焼く。`,
        heatFinish
      ],
      hotpot: [
        `${names}を使いやすい大きさと分量に整え、鍋へ彩りよく並べる。`,
        `${season}と水を加え、ふたをして煮る。`,
        heatFinish
      ]
    };
    return methods[method] || methods.pan;
  }

  const entries = [];
  function add(id, name, minutes, method, requiredItems, pantry, optionalItems = [], months = [], quick = false, art = "") {
    const recipe = { id, name, minutes, required: requiredItems, pantry, optional: optionalItems };
    entries.push({
      recipe,
      steps: generatedSteps(method, recipe),
      months,
      quick,
      art: art || requiredItems.find((item) => !STAPLES.has(item.id))?.id || requiredItems[0].id
    });
  }

  // 時短30件。既存の時短30件と合わせて60件にする。
  add("quick-pork-cabbage-ponzu", "豚こまと白菜のレンジポン酢", 10, "microwave", [required("pork", 100), required("chinese-cabbage", 120)], "酒・ポン酢", [optional("mushroom", 0.25)], [11, 12, 1, 2], true);
  add("quick-chicken-ume-steam", "鶏むねの梅レンジ蒸し", 11, "microwave", [required("chicken", 120), required("umeboshi", 1)], "酒・醤油", [optional("shiso", 0.25)], [], true);
  add("quick-salmon-cabbage-miso", "鮭とキャベツのレンジ味噌蒸し", 12, "microwave", [required("salmon", 1), required("cabbage", 100)], "味噌・酒・みりん", [optional("butter", 10)], [3, 4, 5], true);
  add("quick-tofu-mince", "豆腐のレンジそぼろあん", 12, "microwave", [required("tofu", 1), required("pork-mince", 80)], "醤油・みりん・片栗粉・水", [optional("ginger", 0.25)], [], true);
  add("quick-eggplant-tuna", "なすとツナのレンジ煮", 9, "microwave", [required("eggplant", 2), required("tuna", 1)], "めんつゆ・ごま油", [optional("shiso", 0.25)], [6, 7, 8, 9], true);
  add("quick-potato-butter-soy", "じゃがいものレンジバター醤油", 10, "microwave", [required("potato", 2), required("butter", 10)], "醤油・塩", [optional("green-onion-small", 0.25)], [], true);
  add("quick-pumpkin-cheese", "かぼちゃのレンジチーズ", 11, "microwave", [required("pumpkin", 200), required("cheese", 30)], "塩・こしょう", [optional("bacon", 30)], [9, 10, 11], true);
  add("quick-bean-sprout-egg", "もやしのレンジ卵とじ", 8, "microwave", [required("bean-sprouts", 1), required("eggs", 2)], "鶏がらスープの素・醤油", [optional("garlic-chives", 0.25)], [], true);
  add("quick-spinach-bacon", "ほうれん草とベーコンのレンジ蒸し", 8, "microwave", [required("spinach", 0.5), required("bacon", 50)], "塩・こしょう", [optional("mushroom", 0.25)], [11, 12, 1, 2], true);
  add("quick-mushroom-soy-milk", "きのこの豆乳マグスープ", 7, "mug", [required("mushroom", 0.5), required("soy-milk", 0.25)], "コンソメ・塩・水", [optional("bacon", 30)], [9, 10, 11], true);
  add("quick-mackerel-daikon-bowl", "サバ缶おろし丼", 7, "bowl", [required("rice", 1), required("canned-mackerel", 1), required("radish", 0.15)], "醤油・酢", [optional("green-onion-small", 0.25)], [], true);
  add("quick-tuna-shio-kombu-udon", "ツナ塩昆布うどん", 8, "noodle", [required("udon", 1), required("tuna", 1), required("shio-kombu", 0.1)], "めんつゆ・ごま油", [optional("green-onion-small", 0.25)], [], true);
  add("quick-whitebait-egg-rice", "しらす卵のさっと炒めごはん", 10, "pan", [required("rice", 1), required("whitebait", 0.5), required("eggs", 1)], "醤油・塩・油", [optional("green-onion-small", 0.25)], [], true);
  add("quick-natto-avocado-udon", "納豆アボカドうどん", 7, "noodle", [required("udon", 1), required("natto", 1), required("avocado", 1)], "めんつゆ・わさび", [optional("nori", 0.1)], [6, 7, 8, 9], true);
  add("quick-tofu-tuna-miso-bowl", "豆腐ツナ味噌丼", 6, "bowl", [required("rice", 1), required("tofu", 0.5), required("tuna", 0.5)], "味噌・醤油・ごま油", [optional("cucumber", 0.5)], [], true);
  add("quick-kimchi-natto-somen", "キムチ納豆そうめん", 10, "noodle", [required("somen", 1), required("kimchi", 0.25), required("natto", 1)], "めんつゆ・ごま油", [optional("eggs", 1)], [6, 7, 8], true);
  add("quick-chikuwa-cheese-toast", "ちくわチーズトースト", 8, "toast", [required("bread", 2), required("chikuwa", 0.5), required("cheese", 30)], "マヨネーズ・醤油", [optional("nori", 0.1)], [], true);
  add("quick-ham-egg-cheese-toast", "ハム卵チーズトースト", 10, "toast", [required("bread", 2), required("ham", 0.5), required("eggs", 1), required("cheese", 20)], "マヨネーズ・こしょう", [], [], true);
  add("quick-tomato-natto-tofu", "トマト納豆冷ややっこ", 5, "salad", [required("tofu", 1), required("tomato", 1), required("natto", 1)], "醤油・ごま油", [optional("shiso", 0.25)], [6, 7, 8], true);
  add("quick-cucumber-mackerel-salad", "きゅうりとサバ缶のさっぱり和え", 6, "salad", [required("cucumber", 1), required("canned-mackerel", 1)], "酢・醤油・ごま油", [optional("shio-kombu", 0.1)], [6, 7, 8], true);
  add("quick-cabbage-whitebait-salad", "キャベツとしらすの即席サラダ", 7, "salad", [required("cabbage", 120), required("whitebait", 0.5)], "酢・醤油・ごま油", [optional("nori", 0.1)], [3, 4, 5], true);
  add("quick-tofu-wakame-mug-miso", "豆腐とわかめのマグ味噌汁", 6, "mug", [required("tofu", 0.5), required("wakame", 0.1)], "味噌・だし", [optional("green-onion-small", 0.25)], [], true);
  add("quick-corn-egg-mug-soup", "コーン卵のマグスープ", 7, "mug", [required("corn", 0.5), required("eggs", 1)], "鶏がらスープの素・塩", [optional("cheese", 20)], [6, 7, 8], true);
  add("quick-tomato-tuna-mug-soup", "トマトとツナのマグスープ", 7, "mug", [required("tomato", 1), required("tuna", 0.5)], "コンソメ・塩・こしょう", [optional("cheese", 20)], [6, 7, 8], true);
  add("quick-chilled-soy-milk-udon", "冷やし豆乳うどん", 8, "noodle", [required("udon", 1), required("soy-milk", 0.25), required("cucumber", 0.5)], "めんつゆ・ごま油", [optional("kimchi", 0.25)], [6, 7, 8], true);
  add("quick-ume-whitebait-ochazuke", "梅しらす茶漬け", 5, "bowl", [required("rice", 1), required("umeboshi", 1), required("whitebait", 0.5)], "だし・醤油・湯", [optional("nori", 0.1)], [], true);
  add("quick-mackerel-curry-bowl", "サバ缶カレー丼", 10, "bowl", [required("rice", 1), required("canned-mackerel", 1), required("onion", 0.25)], "カレー粉・醤油・水", [optional("tomato", 0.5)], [], true);
  add("quick-ham-lettuce-bowl", "ハムレタスのさっぱり丼", 6, "bowl", [required("rice", 1), required("ham", 0.5), required("lettuce", 0.25)], "マヨネーズ・醤油・酢", [optional("eggs", 1)], [], true);
  add("quick-cheese-natto-rice", "チーズ納豆ごはん", 5, "bowl", [required("rice", 1), required("natto", 1), required("cheese", 20)], "醤油・こしょう", [optional("nori", 0.1)], [], true);
  add("quick-mushroom-bacon-pasta", "きのこベーコンの時短パスタ", 15, "noodle", [required("pasta", 100), required("mushroom", 0.5), required("bacon", 50)], "醤油・バター・こしょう", [optional("spinach", 0.5)], [9, 10, 11], true);

  // 豚肉15件。
  add("pork-onion-salt-stir", "豚肉と玉ねぎのねぎ塩炒め", 18, "pan", [required("pork", 120), required("onion", 0.5)], "塩・こしょう・ごま油", [optional("green-onion", 0.25)]);
  add("pork-eggplant-rich-miso", "豚肉となすのこっくり味噌炒め", 20, "pan", [required("pork", 120), required("eggplant", 2)], "味噌・砂糖・醤油・油", [optional("bell-pepper", 0.5)], [6, 7, 8, 9]);
  add("pork-potato-ketchup", "豚肉とじゃがいものケチャップ炒め", 22, "pan", [required("pork", 120), required("potato", 2)], "ケチャップ・醤油・こしょう・油", [optional("onion", 0.25)]);
  add("pork-broccoli-oyster", "豚肉とブロッコリーのオイスター炒め", 18, "pan", [required("pork", 120), required("broccoli", 0.5)], "オイスターソース・醤油・油", [optional("mushroom", 0.25)], [2, 3, 4]);
  add("pork-pumpkin-soy", "豚肉とかぼちゃの甘辛煮", 24, "simmer", [required("pork", 120), required("pumpkin", 200)], "醤油・砂糖・みりん・水", [optional("ginger", 0.25)], [9, 10, 11]);
  add("pork-burdock-kinpira", "豚肉とごぼうのきんぴら", 22, "pan", [required("pork", 100), required("burdock", 0.5)], "醤油・砂糖・みりん・ごま油", [optional("carrot", 0.5)], [11, 12, 1, 2]);
  add("pork-lotus-sweet-vinegar", "豚肉とれんこんの甘酢炒め", 22, "pan", [required("pork", 120), required("lotus-root", 0.5)], "酢・醤油・砂糖・油", [optional("bell-pepper", 0.5)], [10, 11, 12]);
  add("pork-tofu-spicy-simmer", "豚肉と豆腐のピリ辛煮", 20, "simmer", [required("pork", 100), required("tofu", 1)], "味噌・醤油・豆板醤・水", [optional("green-onion", 0.25)]);
  add("pork-tomato-ginger", "豚肉とトマトのしょうが炒め", 18, "pan", [required("pork", 120), required("tomato", 1)], "醤油・しょうが・油", [optional("onion", 0.25)], [6, 7, 8]);
  add("pork-corn-butter", "豚肉とコーンのバター醤油炒め", 18, "pan", [required("pork", 120), required("corn", 0.5), required("butter", 10)], "醤油・こしょう", [optional("cabbage", 80)], [6, 7, 8]);
  add("pork-spinach-garlic", "豚肉とほうれん草のにんにく炒め", 18, "pan", [required("pork", 120), required("spinach", 0.5)], "にんにく・醤油・油", [optional("mushroom", 0.25)], [11, 12, 1, 2]);
  add("pork-mushroom-cream", "豚肉ときのこのミルク煮", 25, "simmer", [required("pork", 120), required("mushroom", 0.5), required("milk", 0.3)], "コンソメ・塩・こしょう", [optional("onion", 0.25)], [9, 10, 11, 12, 1, 2]);
  add("pork-sweet-potato-sesame", "豚肉とさつまいものごま味噌煮", 28, "simmer", [required("pork", 120), required("sweet-potato", 1)], "味噌・砂糖・醤油・水", [optional("sesame", 0.1)], [9, 10, 11]);
  add("pork-okra-salt", "豚肉とオクラの塩炒め", 18, "pan", [required("pork", 120), required("okra", 1)], "塩・こしょう・ごま油", [optional("tomato", 0.5)], [6, 7, 8]);
  add("pork-cucumber-shabu", "豚しゃぶときゅうりの香味だれ", 20, "salad", [required("pork", 120), required("cucumber", 1)], "酢・醤油・ごま油", [optional("shiso", 0.25)], [6, 7, 8]);

  // 鶏肉15件。
  add("chicken-lemon-soy", "鶏むねのレモン醤油焼き", 20, "grill", [required("chicken", 150), required("lemon", 0.5)], "醤油・酒・油", [optional("onion", 0.25)]);
  add("chicken-pumpkin-cream", "鶏肉とかぼちゃのクリーム煮", 28, "simmer", [required("chicken-thigh", 150), required("pumpkin", 200), required("milk", 0.3)], "コンソメ・塩・こしょう", [optional("onion", 0.25)], [9, 10, 11]);
  add("chicken-broccoli-cheese", "鶏肉とブロッコリーのチーズ焼き", 25, "bake", [required("chicken", 150), required("broccoli", 0.5), required("cheese", 40)], "塩・こしょう・マヨネーズ", [optional("tomato", 0.5)], [2, 3, 4]);
  add("chicken-eggplant-tomato", "鶏肉となすのトマト煮", 26, "simmer", [required("chicken-thigh", 150), required("eggplant", 2), required("tomato", 1)], "塩・こしょう・コンソメ", [optional("cheese", 20)], [6, 7, 8]);
  add("chicken-cabbage-curry", "鶏肉とキャベツのカレー炒め", 18, "pan", [required("chicken", 150), required("cabbage", 120)], "カレー粉・醤油・油", [optional("onion", 0.25)], [3, 4, 5]);
  add("chicken-potato-mustard", "鶏肉とじゃがいものマスタード焼き", 25, "grill", [required("chicken-thigh", 150), required("potato", 2)], "粒マスタード・醤油・油", [optional("onion", 0.25)]);
  add("chicken-burdock-simmer", "鶏肉とごぼうの照り煮", 28, "simmer", [required("chicken-thigh", 150), required("burdock", 0.5)], "醤油・砂糖・みりん・水", [optional("carrot", 0.5)], [11, 12, 1, 2]);
  add("chicken-lotus-teriyaki", "鶏肉とれんこんの照り焼き", 22, "pan", [required("chicken-thigh", 150), required("lotus-root", 0.5)], "醤油・砂糖・みりん・油", [optional("green-onion", 0.25)], [10, 11, 12]);
  add("chicken-spinach-milk-soup", "鶏肉とほうれん草のミルクスープ", 24, "soup", [required("chicken", 120), required("spinach", 0.5), required("milk", 0.3)], "コンソメ・塩・こしょう", [optional("mushroom", 0.25)], [11, 12, 1, 2]);
  add("chicken-corn-pilaf", "鶏肉とコーンのフライパンピラフ", 22, "pan", [required("rice", 1), required("chicken", 100), required("corn", 0.5)], "コンソメ・バター・こしょう", [optional("onion", 0.25)], [6, 7, 8]);
  add("chicken-sweet-potato-stew", "鶏肉とさつまいもの甘辛煮", 28, "simmer", [required("chicken-thigh", 150), required("sweet-potato", 1)], "醤油・砂糖・みりん・水", [optional("mushroom", 0.25)], [9, 10, 11]);
  add("chicken-okra-ponzu", "鶏むねとオクラのポン酢炒め", 18, "pan", [required("chicken", 150), required("okra", 1)], "ポン酢・酒・油", [optional("tomato", 0.5)], [6, 7, 8]);
  add("chicken-mushroom-butter", "鶏肉ときのこのバター蒸し", 22, "steam", [required("chicken-thigh", 150), required("mushroom", 0.5), required("butter", 10)], "酒・醤油・こしょう", [optional("onion", 0.25)], [9, 10, 11]);
  add("chicken-tofu-salt-soup", "鶏肉と豆腐の塩スープ", 24, "soup", [required("chicken", 120), required("tofu", 1)], "鶏がらスープの素・塩・醤油", [optional("green-onion", 0.25)], [11, 12, 1, 2]);
  add("chicken-chives-egg", "鶏肉とにらの卵炒め", 18, "pan", [required("chicken", 120), required("garlic-chives", 0.5), required("eggs", 2)], "醤油・塩・ごま油", [optional("bean-sprouts", 0.5)]);

  // 牛肉・ひき肉10件。
  add("beef-tomato-stir", "牛肉とトマトのオイスター炒め", 18, "pan", [required("beef", 150), required("tomato", 1)], "オイスターソース・醤油・油", [optional("onion", 0.25)], [6, 7, 8]);
  add("beef-broccoli-oyster", "牛肉とブロッコリーの中華炒め", 20, "pan", [required("beef", 150), required("broccoli", 0.5)], "オイスターソース・醤油・ごま油", [optional("mushroom", 0.25)], [2, 3, 4]);
  add("beef-potato-garlic", "牛肉とじゃがいものにんにく醤油炒め", 22, "pan", [required("beef", 150), required("potato", 2)], "にんにく・醤油・油", [optional("onion", 0.25)]);
  add("beef-mushroom-butter", "牛肉ときのこのバター炒め", 18, "pan", [required("beef", 150), required("mushroom", 0.5), required("butter", 10)], "醤油・こしょう", [optional("green-onion", 0.25)], [9, 10, 11]);
  add("beef-eggplant-miso", "牛肉となすの味噌炒め", 20, "pan", [required("beef", 150), required("eggplant", 2)], "味噌・砂糖・醤油・油", [optional("bell-pepper", 0.5)], [6, 7, 8, 9]);
  add("mince-pumpkin-curry", "ひき肉とかぼちゃのカレー煮", 24, "simmer", [required("ground-meat", 120), required("pumpkin", 200)], "カレー粉・コンソメ・水", [optional("onion", 0.25)], [9, 10, 11]);
  add("mince-lotus-patties", "ひき肉とれんこんのつくね", 26, "grill", [required("ground-meat", 150), required("lotus-root", 0.5), required("eggs", 1)], "醤油・みりん・片栗粉", [optional("green-onion", 0.25)], [10, 11, 12]);
  add("mince-tofu-bowl", "ひき肉と豆腐のそぼろ丼", 20, "bowl", [required("rice", 1), required("ground-meat", 120), required("tofu", 0.5)], "醤油・砂糖・しょうが", [optional("eggs", 1)]);
  add("mince-corn-rice", "ひき肉とコーンのバターごはん", 18, "pan", [required("rice", 1), required("ground-meat", 100), required("corn", 0.5)], "醤油・バター・こしょう", [optional("green-onion-small", 0.25)], [6, 7, 8]);
  add("mince-cabbage-egg", "ひき肉とキャベツの卵炒め", 18, "pan", [required("ground-meat", 120), required("cabbage", 120), required("eggs", 1)], "醤油・塩・こしょう・油", [optional("onion", 0.25)], [3, 4, 5]);

  // 魚介15件。
  add("salmon-tomato-cheese", "鮭とトマトのチーズ焼き", 24, "bake", [required("salmon", 1), required("tomato", 1), required("cheese", 30)], "塩・こしょう・オリーブ油", [optional("onion", 0.25)], [6, 7, 8]);
  add("salmon-potato-miso", "鮭とじゃがいもの味噌バター煮", 26, "simmer", [required("salmon", 1), required("potato", 2), required("butter", 10)], "味噌・みりん・水", [optional("onion", 0.25)]);
  add("salmon-cabbage-cream", "鮭とキャベツのクリーム煮", 25, "simmer", [required("salmon", 1), required("cabbage", 120), required("milk", 0.3)], "コンソメ・塩・こしょう", [optional("mushroom", 0.25)], [3, 4, 5]);
  add("salmon-broccoli-garlic", "鮭とブロッコリーのにんにく蒸し", 22, "steam", [required("salmon", 1), required("broccoli", 0.5)], "にんにく・酒・塩", [optional("butter", 10)], [2, 3, 4]);
  add("salmon-sweet-potato-butter", "鮭とさつまいものバター醤油焼き", 26, "grill", [required("salmon", 1), required("sweet-potato", 1), required("butter", 10)], "醤油・酒・こしょう", [optional("mushroom", 0.25)], [9, 10, 11]);
  add("mackerel-eggplant-miso", "さばとなすの味噌煮", 25, "simmer", [required("mackerel", 1), required("eggplant", 2)], "味噌・砂糖・酒・水", [optional("ginger", 0.25)], [6, 7, 8, 9]);
  add("mackerel-cabbage-curry", "さばとキャベツのカレー蒸し", 22, "steam", [required("mackerel", 1), required("cabbage", 120)], "カレー粉・酒・塩", [optional("onion", 0.25)], [3, 4, 5]);
  add("mackerel-potato-tomato", "さばとじゃがいものトマト煮", 28, "simmer", [required("mackerel", 1), required("potato", 2), required("tomato", 1)], "コンソメ・塩・こしょう", [optional("onion", 0.25)]);
  add("yellowtail-mushroom-teriyaki", "ぶりときのこの照り焼き", 22, "pan", [required("yellowtail", 1), required("mushroom", 0.5)], "醤油・砂糖・みりん・油", [optional("green-onion", 0.25)], [11, 12, 1, 2]);
  add("yellowtail-cabbage-steam", "ぶりと白菜の酒蒸し", 24, "steam", [required("yellowtail", 1), required("chinese-cabbage", 150)], "酒・塩・ポン酢", [optional("mushroom", 0.25)], [11, 12, 1, 2]);
  add("cod-tomato-soup", "たらとトマトの洋風スープ", 24, "soup", [required("cod", 1), required("tomato", 1)], "コンソメ・塩・こしょう", [optional("onion", 0.25)], [6, 7, 8]);
  add("cod-potato-milk", "たらとじゃがいものミルク煮", 27, "simmer", [required("cod", 1), required("potato", 2), required("milk", 0.3)], "コンソメ・塩・こしょう", [optional("spinach", 0.5)], [11, 12, 1, 2]);
  add("shrimp-broccoli-mayo", "えびとブロッコリーのマヨ炒め", 20, "pan", [required("shrimp", 120), required("broccoli", 0.5)], "マヨネーズ・醤油・こしょう", [optional("eggs", 1)], [2, 3, 4]);
  add("shrimp-corn-rice", "えびとコーンの洋風混ぜごはん", 20, "pan", [required("rice", 1), required("shrimp", 100), required("corn", 0.5)], "コンソメ・バター・こしょう", [optional("onion", 0.25)], [6, 7, 8]);
  add("whitebait-cabbage-pasta", "しらすとキャベツの和風パスタ", 20, "noodle", [required("pasta", 100), required("whitebait", 0.5), required("cabbage", 100)], "醤油・オリーブ油・こしょう", [optional("nori", 0.1)], [3, 4, 5]);

  // 卵・豆腐・納豆10件。
  add("tofu-pumpkin-gratin", "豆腐とかぼちゃの味噌グラタン", 25, "bake", [required("tofu", 1), required("pumpkin", 200), required("cheese", 40)], "味噌・マヨネーズ・こしょう", [optional("mushroom", 0.25)], [9, 10, 11]);
  add("tofu-spinach-egg", "豆腐とほうれん草の卵とじ", 20, "simmer", [required("tofu", 1), required("spinach", 0.5), required("eggs", 2)], "だし・醤油・みりん", [optional("mushroom", 0.25)], [11, 12, 1, 2]);
  add("tofu-mushroom-mabo", "きのこ入り塩麻婆豆腐", 22, "pan", [required("tofu", 1), required("ground-meat", 100), required("mushroom", 0.5)], "鶏がらスープの素・塩・片栗粉", [optional("green-onion", 0.25)], [9, 10, 11]);
  add("tofu-tomato-egg-soup", "豆腐とトマトの卵スープ", 18, "soup", [required("tofu", 0.5), required("tomato", 1), required("eggs", 1)], "鶏がらスープの素・醤油・塩", [optional("green-onion-small", 0.25)], [6, 7, 8]);
  add("tofu-cabbage-steak", "豆腐とキャベツの香ばしステーキ", 20, "grill", [required("tofu", 1), required("cabbage", 100)], "醤油・片栗粉・油", [optional("cheese", 20)], [3, 4, 5]);
  add("egg-broccoli-frittata", "ブロッコリーのフライパンオムレツ", 22, "pan", [required("eggs", 3), required("broccoli", 0.5)], "塩・こしょう・油", [optional("cheese", 30)], [2, 3, 4]);
  add("egg-potato-spanish", "じゃがいもの厚焼きオムレツ", 25, "pan", [required("eggs", 3), required("potato", 2)], "塩・こしょう・油", [optional("onion", 0.25)]);
  add("egg-tomato-stir", "トマトと卵のふんわり中華炒め", 16, "pan", [required("eggs", 2), required("tomato", 1)], "鶏がらスープの素・塩・ごま油", [optional("green-onion-small", 0.25)], [6, 7, 8]);
  add("natto-spinach-pasta", "納豆とほうれん草の和風パスタ", 20, "noodle", [required("pasta", 100), required("natto", 1), required("spinach", 0.5)], "醤油・バター・こしょう", [optional("nori", 0.1)], [11, 12, 1, 2]);
  add("natto-tofu-patties", "納豆と豆腐のもちもち焼き", 22, "grill", [required("natto", 1), required("tofu", 1), required("eggs", 1)], "片栗粉・醤油・油", [optional("green-onion-small", 0.25)]);

  // 野菜副菜10件。
  add("cabbage-corn-yogurt-salad", "キャベツとコーンのヨーグルトサラダ", 16, "salad", [required("cabbage", 150), required("corn", 0.5), required("yogurt", 0.5)], "塩・酢・こしょう", [optional("ham", 0.5)], [3, 4, 5]);
  add("pumpkin-yogurt-salad", "かぼちゃのヨーグルトサラダ", 18, "salad", [required("pumpkin", 200), required("yogurt", 0.5)], "マヨネーズ・塩・こしょう", [optional("cucumber", 0.5)], [9, 10, 11]);
  add("sweet-potato-apple-salad", "さつまいもとりんごのサラダ", 20, "salad", [required("sweet-potato", 1), required("apple", 0.5)], "ヨーグルト・塩・こしょう", [optional("cheese", 20)], [9, 10, 11]);
  add("lotus-cheese-grill", "れんこんのチーズ焼き", 20, "bake", [required("lotus-root", 0.5), required("cheese", 30)], "醤油・こしょう・油", [optional("bacon", 30)], [10, 11, 12]);
  add("eggplant-tomato-marinade", "なすとトマトの焼きマリネ", 20, "salad", [required("eggplant", 2), required("tomato", 1)], "酢・醤油・オリーブ油", [optional("shiso", 0.25)], [6, 7, 8]);
  add("broccoli-tuna-salad", "ブロッコリーとツナのごまサラダ", 18, "salad", [required("broccoli", 0.5), required("tuna", 1)], "マヨネーズ・醤油・ごま", [optional("eggs", 1)], [2, 3, 4]);
  add("spinach-mushroom-sesame", "ほうれん草ときのこのごま和え", 18, "salad", [required("spinach", 0.5), required("mushroom", 0.5)], "醤油・砂糖・ごま", [optional("carrot", 0.5)], [9, 10, 11, 12, 1, 2]);
  add("cucumber-corn-yogurt", "きゅうりとコーンのヨーグルト和え", 16, "salad", [required("cucumber", 1), required("corn", 0.5), required("yogurt", 0.5)], "塩・酢・こしょう", [optional("ham", 0.5)], [6, 7, 8]);
  add("carrot-tuna-salad", "にんじんとツナのさっぱりサラダ", 18, "salad", [required("carrot", 1), required("tuna", 1)], "酢・醤油・オリーブ油", [optional("corn", 0.5)]);
  add("potato-shio-kombu-saute", "じゃがいもの塩昆布炒め", 20, "pan", [required("potato", 2), required("shio-kombu", 0.1)], "バター・醤油・こしょう", [optional("green-onion-small", 0.25)]);

  // 麺・ごはん10件。
  add("pork-tomato-udon", "豚肉とトマトの温かいうどん", 20, "noodle", [required("udon", 1), required("pork", 100), required("tomato", 1)], "めんつゆ・しょうが・水", [optional("green-onion", 0.25)], [6, 7, 8]);
  add("chicken-mushroom-udon", "鶏肉ときのこのとろみうどん", 24, "noodle", [required("udon", 1), required("chicken", 100), required("mushroom", 0.5)], "めんつゆ・片栗粉・水", [optional("green-onion", 0.25)], [9, 10, 11, 12, 1, 2]);
  add("mackerel-curry-udon", "サバ缶カレーうどん", 18, "noodle", [required("udon", 1), required("canned-mackerel", 1), required("onion", 0.25)], "カレー粉・めんつゆ・水", [optional("green-onion", 0.25)]);
  add("eggplant-tuna-soba", "なすとツナの温かいそば", 22, "noodle", [required("soba", 100), required("eggplant", 2), required("tuna", 1)], "めんつゆ・しょうが・水", [optional("green-onion", 0.25)], [6, 7, 8, 9]);
  add("natto-tomato-soba", "納豆トマトの冷やしそば", 18, "noodle", [required("soba", 100), required("natto", 1), required("tomato", 1)], "めんつゆ・酢・ごま油", [optional("shiso", 0.25)], [6, 7, 8]);
  add("chicken-shio-kombu-pasta", "鶏肉と塩昆布の和風パスタ", 22, "noodle", [required("pasta", 100), required("chicken", 100), required("shio-kombu", 0.1)], "醤油・オリーブ油・こしょう", [optional("mushroom", 0.25)]);
  add("shrimp-spinach-pasta", "えびとほうれん草のクリームパスタ", 25, "noodle", [required("pasta", 100), required("shrimp", 100), required("spinach", 0.5), required("milk", 0.3)], "コンソメ・塩・こしょう", [optional("cheese", 20)], [11, 12, 1, 2]);
  add("pumpkin-bacon-pasta", "かぼちゃとベーコンのパスタ", 24, "noodle", [required("pasta", 100), required("pumpkin", 150), required("bacon", 50)], "コンソメ・オリーブ油・こしょう", [optional("cheese", 20)], [9, 10, 11]);
  add("salmon-corn-rice", "鮭とコーンのバター混ぜごはん", 20, "pan", [required("rice", 1), required("salmon", 1), required("corn", 0.5), required("butter", 10)], "醤油・こしょう", [optional("green-onion-small", 0.25)], [6, 7, 8]);
  add("beef-mushroom-rice", "牛肉ときのこの甘辛混ぜごはん", 22, "pan", [required("rice", 1), required("beef", 120), required("mushroom", 0.5)], "醤油・砂糖・みりん", [optional("green-onion", 0.25)], [9, 10, 11]);

  // 季節の汁物・鍋5件。
  add("spring-clam-cabbage-soup", "春キャベツとあさりのスープ", 22, "soup", [required("cabbage", 150), required("clam", 1)], "コンソメ・酒・塩", [optional("asparagus", 0.5)], [3, 4, 5]);
  add("summer-tomato-okra-soup", "トマトとオクラの夏スープ", 18, "soup", [required("tomato", 1), required("okra", 1)], "コンソメ・塩・こしょう", [optional("eggs", 1)], [6, 7, 8]);
  add("autumn-sweet-potato-mushroom-soup", "さつまいもときのこの秋スープ", 25, "soup", [required("sweet-potato", 1), required("mushroom", 0.5), required("milk", 0.3)], "コンソメ・塩・こしょう", [optional("bacon", 30)], [9, 10, 11]);
  add("winter-yellowtail-tofu-hotpot", "ぶりと豆腐の冬鍋", 28, "hotpot", [required("yellowtail", 2), required("tofu", 1), required("chinese-cabbage", 200)], "だし・醤油・酒・水", [optional("green-onion", 0.5)], [11, 12, 1, 2]);
  add("winter-chicken-radish-hotpot", "鶏肉と大根のあったか鍋", 30, "hotpot", [required("chicken-thigh", 180), required("radish", 0.3), required("tofu", 0.5)], "だし・醤油・みりん・水", [optional("mushroom", 0.5)], [11, 12, 1, 2]);

  globalThis.RECIPE_EXPANSION = {
    recipes: entries.map((entry) => entry.recipe),
    steps: Object.fromEntries(entries.map((entry) => [entry.recipe.id, entry.steps])),
    seasons: Object.fromEntries(entries.filter((entry) => entry.months.length).map((entry) => [entry.recipe.id, entry.months])),
    fallbacks: Object.fromEntries(entries.map((entry) => [entry.recipe.id, entry.art])),
    quickIds: entries.filter((entry) => entry.quick).map((entry) => entry.recipe.id)
  };
})();
