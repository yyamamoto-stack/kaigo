// content.js（v7：サービス区分・算定時間の3項目に対応（ラベル文言でselectを特定）／v6：goService方式＋保存前応答）
// v7の追加点：実画面のサービス設定ポップアップには、サービス種類選択後にajaxで
//   「サービス区分」「身体介護の算定時間」「生活援助の算定時間」（いずれも必須）が出現する。
//   IDが不定のためラベル文言（th）から同じ行のselectを特定して選択する。
//   この3つを選ぶとサービス内容ラジオと単位数はカイポケが自動選定するため、JSON側のserviceContent/unitsは省略可。
//   JSONの新フィールド: serviceCategory（例 身体・生活）/ physicalCareTime（例 20分以上~30分未満）/ lifeAssistTime（例 20分以上）
// v6の修正点：
//   1. handleOpenServiceModal: 隠しフィールド form:insuranceDiv に 01(保険内)/02(保険外) をセットしてから
//      form:serviceAct を押す（ページ本来の goService('', div) と同じ手順）。
//      → v5 は直接押していたため保険区分が空になり「新規追加（保険外）」で開いていた。
//   2. setRadio: 既にチェック済みならクリックしない（保険区分radioのonchange=ajax全再描画を回避）。
//   3. FILL_SERVICE: 「保存する」クリックでウィンドウが閉じて応答チャネルが切れるため、応答を返してから保存する。
// カイポケ計画書の自動入力コアロジック。計画書は3種類。URLで判定して振る舞う。
//
//   ・要介護  訪問介護計画書        : メイン MEM093151(新規)/MEM093103(編集)  + サービス設定は別ウィンドウ MEM093104
//   ・要支援  介護予防訪問介護計画書 : メイン MEM093155                        + サービス設定は別ウィンドウ MEM093104
//   ・障害    居宅介護等計画書       : メイン MEM083101(新規)/MEM083103(編集)  + サービス設定はインライン disableFormPopup
//
// 【コンプライアンス】（claude.md）内部API直叩き禁止・全アクション間 humanSleep・waitForElement は10秒タイムアウト＋安全停止。
// 【JSF/RichFaces】idはコロン付き（form:xxx）→ 属性セレクタ [id="..."] で指定。選択のたびにajax再描画が入るため待機が重要。
// 【実装状況】3種とも実HTML（MEM093103/093155/093104/083103）から実DOMを反映。ライブ動作の微調整は要検証。

// 属性セレクタ生成（JSFのコロンidを安全に指定）
const ID = (id) => `[id="${id}"]`;
// 曜日 → checkedDays の value（実DOMのラベルより確定: 01=日 … 07=土）
const WD = { '日': '01', '月': '02', '火': '03', '水': '04', '木': '05', '金': '06', '土': '07' };

// =============================================================
// PROFILES — 計画書種別ごとのセレクタ集約（ハードコード禁止）
// =============================================================
const PROFILES = {
  // ---------- 要介護 訪問介護計画書 ----------
  youkaigo: {
    label: '要介護 訪問介護計画書',
    // 093151=新規 / 093103=一覧からの編集 / 093102=登録直後の編集（実機で確認）
    match: ['MEM093151', 'MEM093103', 'MEM093102'],
    mode: 'window',
    servicePopupMatch: 'MEM093104',
    isYoshien: false,
    sel: mainSelKaigo(false),
    popupSel: popupSel093104(),
  },
  // ---------- 要支援 介護予防訪問介護計画書 ----------
  youshien: {
    label: '要支援 介護予防訪問介護計画書',
    // 093155=新規 / 093114=登録直後の編集 / 093115=サービス保存後・一覧からの編集（いずれも実機で確認 7/14）
    match: ['MEM093155', 'MEM093114', 'MEM093115'],
    mode: 'window',
    servicePopupMatch: 'MEM093104',
    isYoshien: true,
    sel: mainSelKaigo(true),
    popupSel: popupSel093104(),
  },
  // ---------- 障害 居宅介護等計画書 ----------
  shogai: {
    label: '障害 居宅介護等計画書',
    // 083101=新規 / 083103=一覧から編集 / 083102=登録直後の編集（実機で確認 7/15）
    match: ['MEM083101', 'MEM083103', 'MEM083102'],
    mode: 'inline',
    sel: mainSelShogai(),
    popupSel: popupSelShogai(),
  },
};

// 要介護/要支援 メイン画面の実DOMセレクタ
function mainSelKaigo(isYoshien) {
  return {
    createdDate: { era: ID('form:makeYmdEra'), year: ID('form:makeYmdYear'), month: ID('form:makeYmdMonth'), day: ID('form:makeYmdDay') },
    insuredProof: ID('form:ledInsuredPersonProofInternalId'),      // 被保険者証（適用期間）
    author: ID('form:planMakePersonId'),                           // 計画作成者氏名
    communityGeneralSc: isYoshien ? ID('form:communityGeneralScId') : null, // 介護予防支援事業所（要支援のみ）
    careOffice: ID('form:homeCareSoId'),                           // 居宅介護支援事業所
    careManager: ID('form:companyChargeCareManagerId'),            // 担当ケアマネージャー
    issues: ID('form:pivotSolutionThemeSubject'),                  // 解決すべき課題
    longTerm: ID('form:longTimePeriodMarkSubject'),                // 長期目標
    shortTerm: ID('form:shortTermMarkSubject'),                    // 短期目標
    hopePerson: ID('form:personHimselfHopeSubject'),               // 本人・家族の希望
    notes: ID('form:heedPointMatterSubject'),                      // 留意点
    serviceActButton: ID('form:serviceAct'),                       // 「新規追加する」→サービス設定ポップアップ（別ウィンドウ）
    // 援助内容: form:listDetail:{S}:{field}{R}（S=サービス0始まり, R=行1..7）
    support: {
      division: (s, r) => ID(`form:listDetail:${s}:visitServiceAlternateDivision${r}`),
      item: (s, r) => ID(`form:listDetail:${s}:visitServiceAlternateAssistDivision${r}`),
      content: (s, r) => ID(`form:listDetail:${s}:serviceConcreteSubject${r}`),
      time: (s, r) => ID(`form:listDetail:${s}:timeRequired${r}`),
      notes: (s, r) => ID(`form:listDetail:${s}:heedPointMatterSubject${r}`),
      maxRows: 7,
    },
    deliveryDate: { era: ID('form:startDate1Era'), year: ID('form:startDate1Year'), month: ID('form:startDate1Month'), day: ID('form:startDate1Day') }, // 説明日
    explainer: ID('form:descriptionPersonId'),                     // 説明者
    // 作成状態(form:a24) と 登録(form:update) は自動化では触らない（人間が押す）
  };
}

// 介護のサービス設定ポップアップ（MEM093104, 別ウィンドウ）の実DOMセレクタ
function popupSel093104() {
  return {
    root: ID('form:serviceKind'),
    insuranceInside: ID('form:insuranceDivision:0'),   // 01 保険内
    insuranceOutside: ID('form:insuranceDivision:1'),  // 02 保険外
    serviceKind: ID('form:serviceKind'),               // サービス種類
    servicePlant: ID('form:servicePlant'),             // サービス事業所
    serviceContentBox: ID('form:service_content'),     // サービス内容（種類選択後にajaxで読み込まれるラジオ群）
    unit: ID('form:unit'),                             // 単位数
    startHour: ID('form:startHour'), startMin1: ID('form:startMinute1'), startMin2: ID('form:startMinute2'),
    endHour: ID('form:endHour'), endMin1: ID('form:endMinute1'), endMin2: ID('form:endMinute2'),
    weeklyRadio: ID('form:supportDay01:0'),            // 毎週/奇数/偶数 側
    weekType: ID('form:weekType'),                     // 01毎週 02奇数週 03偶数週
    checkedDay: (day) => `input[name="form:checkedDays"][value="${WD[day]}"]`,
    nthRadio: ID('form:supportDay02:0'),               // 第N曜日 側
    weekCount: ID('form:weekCount'),                   // 04第1..08最終
    nthDay: ID('form:day'),                            // 01日曜..07土曜
    regist: ID('form:regist'),                         // 保存する
    time: 'split3',                                    // 時刻の入力形式（時/分十/分一）
  };
}

// 障害 居宅介護等計画書 メイン画面の実DOMセレクタ
function mainSelShogai() {
  return {
    createdDate: { era: ID('form:makeYmdEra'), year: ID('form:makeYmdYear'), month: ID('form:makeYmdMonth'), day: ID('form:makeYmdDay') },
    author: ID('form:planMakePersonId'),
    hopePerson: ID('form:hopePerson'),                 // 本人・家族の希望
    assistanceGoal: ID('form:assistanceGoal'),         // 援助目標
    // 契約支給量（障害のみ）: form:loop:N
    supplyQty: (n) => ID(`form:loop:${n}:contractSupplyQuantity`),
    // 援助内容フラット: form:service:N
    support: {
      division: (n) => ID(`form:service:${n}:serviceAlternateDivision`),
      item: (n) => ID(`form:service:${n}:serviceAlternateAssistDivision`),
      time: (n) => ID(`form:service:${n}:timeRequire`),
      notes: (n) => ID(`form:service:${n}:heedPointMatterSubject`),
      hope: (n) => ID(`form:service:${n}:personAndFamilyAssistance`),
    },
    addSupportRow: 'input[alt="行を追加する"], img[alt="行を追加する"]',
    deliveryDate: { era: ID('form:deliveryDayEra'), year: ID('form:deliveryDayYear'), month: ID('form:deliveryDayMonth'), day: ID('form:deliveryDayDay') },
    addServiceButton: 'input[alt="新規追加する"], img[alt="新規追加する"]',
  };
}

// 障害のサービス設定（インライン disableFormPopup）
function popupSelShogai() {
  return {
    root: ID('disableFormPopup:serviceKindId'),
    insuranceInside: ID('disableFormPopup:insuranceDivision:0'),   // 04（障害）
    insuranceOutside: ID('disableFormPopup:insuranceDivision:1'),  // 02
    serviceKind: ID('disableFormPopup:serviceKindId'),
    servicePlant: ID('disableFormPopup:servicePlant'),
    startTime: ID('disableFormPopup:startTime'),                   // text（例 08:00）
    endTime: ID('disableFormPopup:endTime'),
    checkedDay: (day) => `input[name="disableFormPopup:checkedDays"][value="${WD[day]}"]`,
    regist: ID('disableFormPopup:regist'),
    time: 'text',
  };
}

// URL からプロファイル判定
function detectProfile() {
  const href = location.href;
  for (const key of Object.keys(PROFILES)) {
    const p = PROFILES[key];
    if ((p.match || []).some((m) => href.includes(m))) return { key, ...p };
    if (p.servicePopupMatch && href.includes(p.servicePopupMatch)) return { key, ...p, isServicePopup: true };
  }
  return null;
}

// =============================================================
// コアスキル
// =============================================================
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function humanSleep() { return sleep(500 + Math.floor(Math.random() * 1001)); }

function waitForElement(selector, options = {}) {
  const { timeout = 10000, interval = 200, root = document, visible = true } = options;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const isVisible = (el) => {
      if (!visible) return true;
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const tick = () => {
      const el = root.querySelector(selector);
      if (el && isVisible(el)) { resolve(el); return; }
      if (Date.now() - startedAt >= timeout) { reject(new Error(`要素が見つかりませんでした（タイムアウト ${timeout}ms）: "${selector}"`)); return; }
      setTimeout(tick, interval);
    };
    tick();
  });
}

// 【v2.11.0・コンプライアンス方針】カイポケの内部JS（dirtyCheckA4J等）を書き換えて
// 「このページからほかのページに移動しますか？」の確認を抑止する処理は撤去した。
// カイポケ自動化の社内遵守事項「公開されている画面操作の範囲内に留める／内部プログラムへの
// 直接アクセス・改変はしない」に沿うため、確認ダイアログが出ない“操作の順序”で回避する：
//   フォーム送信リンク（サービス追加ボタン・援助内容タブ）は【未保存の変更が無い状態でのみ】
//   クリックする。具体的には、基本情報を入れたら一旦人が「登録する」で保存し、以後の追加操作は
//   保存済み（＝未保存の変更なし）の状態で行う。入力欄は既に同じ値なら書き換えない（下記fillInput）
//   ことで、再実行時に不要な変更＝dirty状態を作らない。

function setNativeValue(element, value) {
  if (!element) throw new Error('setNativeValue: 対象要素が null です。');
  const proto = Object.getPrototypeOf(element);
  const ownSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
  const protoSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (protoSetter && ownSetter !== protoSetter) protoSetter.call(element, value);
  else if (ownSetter) ownSetter.call(element, value);
  else element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function safeClick(element) {
  if (!element) throw new Error('safeClick: クリック対象が null です。処理を停止します。');
  if (element.disabled) throw new Error('safeClick: クリック対象が disabled 状態です。処理を停止します。');
  element.scrollIntoView({ block: 'center', inline: 'center' });
  if (typeof element.focus === 'function') element.focus();
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  element.click();
}

async function fillInput(selector, value, options = {}) {
  if (value === undefined || value === null || value === '') return;
  const el = await waitForElement(selector, options);
  // 既に同じ値なら書き換えない（再実行時に不要なdirty状態＝移動確認ダイアログの原因を作らない）
  if (String(el.value) === String(value)) return;
  await humanSleep(); setNativeValue(el, String(value)); await humanSleep();
}

// 全角数字→半角（JSONを手修正した際の全角入力「令和８年」等への対策）
const z2h = (s) => String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

// 全角/半角スペース等の空白差と、全角数字・括弧・スラッシュ、チルダ表記ゆれ（~ ～ 〜）、期間表記ゆれ（AからBまで⇔A~B）を無視して照合する
// （例「向日葵　介護センター」vs「向日葵 介護センター」、「訪問型サービス（独自/低率）」vs「訪問型サービス(独自／低率)」）
const norm = (s) => z2h(String(s)).replace(/[\s　]+/g, '').replace(/[~～〜]/g, '~').replace(/から/g, '~').replace(/まで/g, '')
  .replace(/（/g, '(').replace(/）/g, ')').replace(/／/g, '/')
  .replace(/[①-⑩]/g, (c) => String(c.charCodeAt(0) - 0x245F)) // 丸数字→数字（例: 障害支援区分⑥⇔区分6）
  .replace(/低率/g, '定率'); // 予防サービス種類の正しい表記は「定率」（7/15実機確認）。旧JSONの「低率」を読み替える

// <select>から表記ゆれを許容してoptionを選ぶ（selectOption/selectOptionByLabel共通）
function pickOption(el, value, what) {
  const target = String(value).trim();
  const nt = norm(target);
  let matched = null;
  for (const opt of Array.from(el.options || [])) {
    if (opt.value === target || norm(opt.textContent) === nt) { matched = opt; break; }
  }
  if (!matched && nt) for (const opt of Array.from(el.options || [])) { if (norm(opt.textContent).includes(nt)) { matched = opt; break; } }
  if (!matched) {
    // 原因調査のため、その時点で実際にあった選択肢を（先頭15件まで）エラー文に含める
    const opts = Array.from(el.options || []).map((o) => (o.textContent || '').trim()).filter(Boolean).slice(0, 15).join(' ／ ');
    throw new Error(`選択肢が見つかりません: ${what} に「${target}」なし（カイポケ登録値と不一致の可能性）。その時点の選択肢: ${opts || '（空＝読み込み前の可能性）'}`);
  }
  if (el.value === matched.value) return; // 既に選択済みなら触らない（onchangeの不要なajax再描画を避ける）
  setNativeValue(el, matched.value);
}

async function selectOption(selector, value, options = {}) {
  if (value === undefined || value === null || value === '') return;
  await waitForElement(selector, options);
  await humanSleep();
  // ajax再描画で選択肢が後から充填される/要素ごと差し替えられるselectがあるため、
  // 一致する選択肢が現れるまで一定時間リトライする（毎回要素を取り直す）
  const deadline = Date.now() + (options.optionTimeout || 8000);
  for (;;) {
    try {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`要素が見つかりません: "${selector}"`);
      pickOption(el, value, `"${selector}"`);
      break;
    } catch (e) {
      if (Date.now() >= deadline) throw e;
      await sleep(400);
    }
  }
  await humanSleep();
}

// ラベル文言（th/tdセルのテキスト）から同じ行の<select>を探す。
// サービス区分・算定時間などIDが不定／ajaxで後から出現する項目向け（ポーリングつき）。
// 注意: カイポケは同じ文言のラベルが非表示ブロックにも存在することがあるため、
//   一致する全ラベルセルを走査し「表示中かつ有効なselectを持つ行」だけを採用する。
//   ラベルセルは文言が最も短い（＝余計な内容を含まない）ものから優先する。
async function waitForLabeledSelect(labelText, timeout = 15000) {
  const deadline = Date.now() + timeout;
  const nt = norm(labelText);
  const isShown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  while (Date.now() < deadline) {
    const cells = [...document.querySelectorAll('th, td')]
      .filter((t) => !t.querySelector('select') && norm(t.textContent).includes(nt))
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    for (const cell of cells) {
      const row = cell.closest('tr');
      const sel = row && row.querySelector('select');
      if (sel && !sel.disabled && isShown(sel)) return sel;
    }
    await sleep(200);
  }
  // 欄が無いのは画面構成上の正常ケースもあるため、警告ではなく情報ログに留める
  console.info(`waitForLabeledSelect: 「${labelText}」の欄なし（ラベル存在=${
    [...document.querySelectorAll('th, td')].some((t) => norm(t.textContent).includes(nt))
  }）`);
  return null;
}

// ラベル文言で特定した<select>に選択を入れる。欄が無ければ警告してスキップ
// （要支援など画面によって存在しない項目があるため。必須欄の入れ忘れは保存時バリデーションで停止する）。
async function selectOptionByLabel(labelText, value) {
  if (value === undefined || value === null || value === '') return true;
  const el = await waitForLabeledSelect(labelText);
  if (!el) { console.warn(`「${labelText}」の欄が見つからずスキップ:`, value); return false; }
  await humanSleep();
  pickOption(el, value, `「${labelText}」`);
  await humanSleep();
  return true;
}

// 選択肢と不一致でも全体を止めたくない項目用（警告してスキップ。人が目視で補正する前提）。
// skipped配列を渡すと、スキップした項目名を積んで完了メッセージで利用者に知らせられる。
async function selectOptionByLabelSoft(labelText, value, skipped) {
  try {
    const done = await selectOptionByLabel(labelText, value);
    if (!done && skipped) skipped.push(`${labelText}（欄が見つからない）`);
  } catch (e) {
    console.warn(`「${labelText}」は選択できずスキップ（手動確認してください）:`, e && e.message);
    if (skipped) skipped.push(`${labelText}（選択肢と不一致）`);
  }
}

async function setRadio(selector, options = {}) {
  const el = await waitForElement(selector, options);
  // 既に選択済みなら触らない（保険区分radioはonchangeにajax全画面再描画が仕込まれており、
  // 不要なクリックは再描画→通信切断の原因になる）
  if (el.checked) { await humanSleep(); return; }
  await humanSleep();
  el.checked = true;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  safeClick(el); await humanSleep();
}

async function setCheckbox(selector, checked, options = {}) {
  const el = await waitForElement(selector, options);
  if (el.checked !== !!checked) { await humanSleep(); safeClick(el); el.dispatchEvent(new Event('change', { bubbles: true })); }
  await humanSleep();
}

// 和暦の日付select（元号/年/月/日）へ入力する。日付が原因で処理全体を止めない：
//   ・解釈できない場合、fallbackToday=true なら実行日（今日）を入れる。それ以外はスキップ（画面の値のまま）。
//   ・選択肢との不一致など入力自体の失敗も警告してスキップする（人が目視確認する前提）。
async function setWarekiDate(dateSelectors, warekiStr, { fallbackToday = false } = {}) {
  if (!dateSelectors) return;
  let p = parseWareki(warekiStr);
  if (!p) {
    if (!warekiStr && !fallbackToday) return;
    if (fallbackToday) {
      if (warekiStr) console.warn(`日付「${warekiStr}」を解釈できないため実行日（今日）を入力します。`);
      p = todayWareki();
    } else {
      console.warn(`日付「${warekiStr}」を解釈できないためスキップします（画面の値のまま）。`);
      return;
    }
  }
  try {
    await selectOption(dateSelectors.era, p.era);
    await selectOption(dateSelectors.year, p.year);
    await selectOption(dateSelectors.month, p.month);
    await selectOption(dateSelectors.day, p.day);
  } catch (e) {
    console.warn('日付欄の入力に失敗したためスキップします（画面の値を目視確認してください）:', e && e.message);
  }
}
// 和暦・西暦のどちらの表記も受け付ける（全角数字・空白・元年は norm/z2h と同様に吸収）
//   例: 令和8年7月13日 / 令和元年5月1日 / ２０２６年７月１４日 / 2026/7/14 / 2026-07-14
function parseWareki(s) {
  if (!s) return null;
  const t = z2h(String(s)).replace(/[\s　]/g, '').replace(/元年/, '1年');
  let m = t.match(/(明治|大正|昭和|平成|令和)(\d+)年(\d+)月(\d+)日/);
  if (m) return { era: m[1], year: String(parseInt(m[2], 10)), month: String(parseInt(m[3], 10)), day: String(parseInt(m[4], 10)) };
  m = t.match(/(\d{4})[年\/\-](\d{1,2})[月\/\-](\d{1,2})日?/);
  if (m) {
    const y = parseInt(m[1], 10);
    if (y >= 2019) return { era: '令和', year: String(y - 2018), month: String(parseInt(m[2], 10)), day: String(parseInt(m[3], 10)) };
  }
  return null;
}
// 実行日（今日）の和暦表現。作成年月日のフォールバックに使う。
function todayWareki() {
  const d = new Date();
  return { era: '令和', year: String(d.getFullYear() - 2018), month: String(d.getMonth() + 1), day: String(d.getDate()) };
}

// "08:15" → "0815"（障害ポップアップの時間テキスト欄・4桁）。既に数字のみなら4桁に整える。
function toHHMM(t) {
  if (!t) return t;
  const s = String(t).replace(/[^0-9]/g, '');
  return s.length === 3 ? '0' + s : s; // 例 "830"→"0830"
}

// "08:15" → {hour:'8', min1:'1', min2:'5'}（介護ポップアップの時/分十/分一）
function splitTime3(t) {
  const m = t && String(t).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return { hour: String(parseInt(m[1], 10)), min1: m[2][0], min2: m[2][1] };
}

// 介護ポップアップ：サービス内容ラジオ（種類選択後にajaxで出現）を表示テキストで選択（無ければ警告してスキップ）
async function selectServiceContentRadio(boxSel, text) {
  if (!text) return;
  let box;
  try { box = await waitForElement(boxSel, { timeout: 8000, visible: false }); } catch (_) { return; }
  await humanSleep();
  const labels = box.querySelectorAll('label');
  for (const lb of labels) {
    if (lb.textContent && lb.textContent.trim().includes(text)) {
      const inp = lb.htmlFor ? box.querySelector(`[id="${lb.htmlFor}"]`) : lb.previousElementSibling;
      if (inp) { safeClick(inp); await humanSleep(); return; }
    }
  }
  console.warn('サービス内容の選択肢が見つからずスキップ:', text);
}

// =============================================================
// 要介護/要支援（window）: 個別コマンド（background が順序制御）
// =============================================================
async function handleFillBasic(profile, basicInfo = {}) {
  const S = profile.sel;
  // 作成年月日（必須欄）：JSONの作成日を入れる。解釈できない場合は実行日（今日）
  await setWarekiDate(S.createdDate, basicInfo.createdDate, { fallbackToday: true });
  // 【運用ルール 2026/07/14】被保険者証適用期間・地域包括支援センター・居宅介護支援事業所・
  // 担当ケアマネージャーの4つの選択式項目は自動入力の対象外（人がカイポケ上で選択する）。
  // 原案JSONの値は原案画面のプレビューに「※手入力」の参考値として表示される。
  await fillInput(S.author, basicInfo.author);
  await fillInput(S.issues, basicInfo.issues);
  await fillInput(S.longTerm, basicInfo.longTermGoal);
  await fillInput(S.shortTerm, basicInfo.shortTermGoal);
  await fillInput(S.hopePerson, basicInfo.personFamilyHope);
  await fillInput(S.notes, basicInfo.notes);
}

async function handleOpenServiceModal(profile, insuranceType) {
  // ページ本来の goService('', div) と同じ手順で開く：
  // 隠しフィールド form:insuranceDiv に保険区分（01=保険内/02=保険外）をセットしてから
  // ajaxボタン form:serviceAct をクリックする。
  // ※直接 form:serviceAct を押すと保険区分が空のまま→「新規追加（保険外）」で開いてしまう。
  const div = insuranceType === '保険外' ? '02' : '01';
  const hvnId = document.querySelector(ID('form:hvnPlanDetailId'));
  const insDiv = document.querySelector(ID('form:insuranceDiv'));
  if (hvnId) hvnId.value = '';
  if (insDiv) insDiv.value = div;
  const btn = await waitForAddServiceButton(profile.sel.serviceActButton);
  await humanSleep(); safeClick(btn); await humanSleep(); // ajax送信完了時に openPopup() で別ウィンドウが開く
}

// 「新規追加する」ボタンを頑健に探す（id → alt/value/テキストに「新規追加」を含む要素の順）
async function waitForAddServiceButton(idSelector, timeout = 10000) {
  const deadline = Date.now() + timeout;
  const find = () => {
    if (idSelector) { const el = document.querySelector(idSelector); if (el) return el; }
    return [...document.querySelectorAll('input,img,button,a')].find((e) => {
      const t = (e.getAttribute('alt') || e.value || e.textContent || '').replace(/[\s　]/g, '');
      return t.includes('新規追加');
    }) || null;
  };
  while (Date.now() < deadline) {
    const el = find();
    if (el) return el;
    await sleep(200);
  }
  throw new Error('「新規追加する」ボタンが見つかりませんでした。新規作成画面では、先に基本情報を保存（作成中）してからサービス追加が必要な可能性があります。');
}

// 週間計画表から入力済みサービスの行テキストを取得（再実行時のスキップ判定用）。
// 「サービス 1」等のリンクを含む行の全テキスト（時間帯・提供日を含む）を返す。
function getExistingServices() {
  const links = [...document.querySelectorAll('a')].filter((a) => /^サービス\s*\d+$/.test((a.textContent || '').trim()));
  return links.map((a) => {
    const tr = a.closest('tr');
    return { text: tr ? (tr.textContent || '').replace(/\s+/g, ' ').trim() : '' };
  });
}

// サービス追加ボタンが今この画面に在るか（新規画面＝無い＝保存が先）。短時間チェック・非throw。
async function hasAddServiceButton() {
  const idSel = (PROFILE.sel && (PROFILE.sel.serviceActButton || PROFILE.sel.addServiceButton)) || null;
  try { await waitForAddServiceButton(idSel, 3000); return true; } catch (_) { return false; }
}

// 予防（予訪問介護）のサービス種類を決める（運用ルール 2026/07/14、表記は7/15実機確認）：
//   訪問型サービス（独自）      … 身体的介助がある、または「一緒に行う」等の見守り的支援がある場合
//   訪問型サービス（独自/定率） … 掃除・調理・洗濯など身体介助が不要な場合（＝生活支援型サービス）
//   ※実画面には「訪問型サービス（独自/定額）」もあるが現運用では使わない
// AIが正しい表記（訪問型…）で出力していればそれを使い、旧表記（訪問介護等）なら援助内容から自動判定する。
function yoshienServiceKind(service) {
  const t = String(service.serviceType || '');
  if (t.indexOf('訪問型') >= 0) return t;
  const det = Array.isArray(service.supportDetails) ? service.supportDetails : [];
  const hasBody = det.some((d) =>
    String(d.category || '').indexOf('身体') >= 0 ||
    /一緒/.test(String(d.item || '') + String(d.content || '')));
  return hasBody ? '訪問型サービス（独自）' : '訪問型サービス（独自/定率）';
}

// ポップアップ（MEM093104）側のフォーム入力
// ※このポップアップは要介護/要支援で共通URLのため、種別は background から isYoshien で受け取る
//   （popup側の detectProfile では判別できない）
async function handleFillServiceKaigo(profile, service = {}, basicInfo = {}, isYoshien = false) {
  const P = profile.popupSel;
  const skipped = []; // 自動選択できなかった項目（完了メッセージで利用者に知らせる）
  await waitForElement(P.root); await humanSleep();
  await setRadio(service.insuranceType === '保険外' ? P.insuranceOutside : P.insuranceInside);
  if (isYoshien) {
    // ---- 予防（予訪問介護）: サービス種類→（ajaxで保険者・サービス区分等が出現） ----
    // サービス種類の選択肢はajaxで遅れて入ることがあり、タイミングによって失敗していたため長めに待つ
    await selectOption(P.serviceKind, yoshienServiceKind(service), { optionTimeout: 20000 });
    await sleep(1200);
    await selectOption(P.servicePlant, service.serviceOffice, { optionTimeout: 15000 });
    // 保険者：地域包括支援センター名の「名古屋市●●区」を選ぶ（例: 名古屋市中川区西部いきいき支援センター→名古屋市中川区）
    const ward = String(basicInfo.communityGeneralSc || '').match(/名古屋市.+?区/);
    if (ward) await selectOptionByLabelSoft('保険者', ward[0], skipped);
    else { skipped.push('保険者（包括支援センター名から判定できず）'); console.warn('保険者は判定できずスキップ（手動選択してください）'); }
    await sleep(1000); // 保険者選択のajax再描画を待ってからサービス区分へ
    // サービス区分：週間計画（毎週＋提供曜日）で運用しているため「1週当たり」を選ぶ。
    // ※選んだサービス種類によってはこの欄自体が表示されない（例: 独自/定率。7/15実機確認）。
    //   欄が無いのは正常なのでスキップ扱いにしない。真の入れ忘れは保存時バリデーションで停止する。
    const kubunSel = await waitForLabeledSelect('サービス区分', 8000);
    if (kubunSel) {
      await humanSleep();
      try { pickOption(kubunSel, '1週当たりの標準的な回数を定める場合', '「サービス区分」'); }
      catch (e) { skipped.push('サービス区分（選択肢と不一致）'); console.warn(e && e.message); }
      await humanSleep();
    } else {
      console.info('サービス区分: このサービス種類では欄が表示されないためスキップ（正常）');
    }
    await sleep(1000);
    // 日割り・サ責配置減算・事業所と同一の建物の利用者減算・単位数パターン・単位数・サービス内容は
    // 触らない（カイポケの自動算定または人の判断項目。運用ルール 2026/07/14）
  } else {
    // ---- 要介護: サービス種類→（ajaxで区分・算定時間・サービス内容欄が読み込まれる） ----
    await selectOption(P.serviceKind, service.serviceType, { optionTimeout: 20000 });
    await sleep(1200);
    await selectOption(P.servicePlant, service.serviceOffice, { optionTimeout: 15000 });
    // サービス区分・算定時間（実画面の必須3項目。選択するとサービス内容ラジオと単位数がカイポケ側で自動更新される）
    await selectOptionByLabel('サービス区分', service.serviceCategory);
    await sleep(1000);
    await selectOptionByLabel('身体介護の算定時間', service.physicalCareTime);
    await sleep(1000);
    await selectOptionByLabel('生活援助の算定時間', service.lifeAssistTime);
    await sleep(1000);
    // サービス内容ラジオは上記3項目からカイポケが自動選定するため、JSONで明示指定された場合のみ上書き選択
    await selectServiceContentRadio(P.serviceContentBox, service.serviceContent);
    // 単位数もサービス内容から自動算定される。JSONで明示指定された場合のみ上書き
    await fillInput(P.unit, service.units);
  }
  const st = splitTime3(service.startTime), et = splitTime3(service.endTime);
  if (st) { await selectOption(P.startHour, st.hour); await selectOption(P.startMin1, st.min1); await selectOption(P.startMin2, st.min2); }
  if (et) { await selectOption(P.endHour, et.hour); await selectOption(P.endMin1, et.min1); await selectOption(P.endMin2, et.min2); }
  // 提供日（既定=毎週）。第N指定は provisionNthWeek がある場合。
  if (service.provisionNthWeek) {
    await setRadio(P.nthRadio);
    await selectOption(P.weekCount, service.provisionNthWeek); // 例「第1」
    if (service.provisionDays && service.provisionDays[0]) await selectOption(P.nthDay, service.provisionDays[0] + '曜日');
  } else {
    await setRadio(P.weeklyRadio);
    await selectOption(P.weekType, service.provisionCycle || '毎週');
    for (const d of (service.provisionDays || [])) await setCheckbox(P.checkedDay(d), true);
  }
  const regist = await waitForElement(P.regist);
  await humanSleep();
  return { regist, skipped }; // クリックは呼び出し側で行う（保存でウィンドウが閉じて応答が返せなくなるため）
}

// 援助内容の「サービスN」タブ（whichTrnHvnCarePlanDetail送信）を探す。
// 週間計画表の「サービス N」リンク（goService）と区別するため onclick の中身で判定する。
function findSupportTab(number) {
  const label = 'サービス' + number;
  return [...document.querySelectorAll('a')].find((a) =>
    (a.textContent || '').replace(/[\s　]/g, '') === label &&
    String(a.getAttribute('onclick') || '').indexOf('whichTrnHvnCarePlanDetail') >= 0
  ) || null;
}

// 援助内容（listDetail:{S}）に行を入力
// 実DOMでは、援助内容は「選択中のタブの1サービス分」だけが listDetail:{S}（通常S=0）として存在する。
// 指定indexの要素が無い場合は、DOMに実在するSを自動検出して使う。
async function handleFillSupport(profile, index, supportDetails = []) {
  const S = profile.sel.support;
  let s = index;
  if (supportDetails.length && !document.querySelector(S.division(s, 1))) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const el = document.querySelector('[id^="form:listDetail:"][id*=":visitServiceAlternateDivision1"]');
      const m = el && el.id.match(/^form:listDetail:(\d+):/);
      if (m) { s = Number(m[1]); break; }
      await sleep(300);
    }
  }
  return fillSupportRows(profile, s, supportDetails);
}

// 援助内容の行入力。区分・項目がAI出力の表記ゆれでマスタ選択肢に無くても止めない：
// 項目は「その他」で代用し、スキップ内容の一覧を返す（backgroundが完了メッセージで知らせる）
async function fillSupportRows(profile, index, supportDetails = []) {
  const S = profile.sel.support;
  const max = S.maxRows || supportDetails.length;
  const skipped = [];
  for (let i = 0; i < supportDetails.length && i < max; i++) {
    const d = supportDetails[i], r = i + 1; // 行は1始まり
    const rowTag = `援助内容${r}行目`;
    if (d.category) {
      try { await selectOption(S.division(index, r), d.category, { visible: false, optionTimeout: 2000 }); }
      catch (_) { skipped.push(`${rowTag}: 区分「${d.category}」が選択肢に無いためスキップ`); }
    }
    if (d.item) {
      try { await selectOption(S.item(index, r), d.item, { visible: false, optionTimeout: 2000 }); }
      catch (_) {
        try {
          await selectOption(S.item(index, r), 'その他', { visible: false, optionTimeout: 2000 });
          skipped.push(`${rowTag}: 項目「${d.item}」が選択肢に無いため「その他」で代用`);
        } catch (_) { skipped.push(`${rowTag}: 項目「${d.item}」が選択できずスキップ`); }
      }
    }
    if (d.content) await fillInput(S.content(index, r), d.content, { visible: false });
    if (d.requiredTime) await fillInput(S.time(index, r), d.requiredTime, { visible: false });
    if (d.notes) await fillInput(S.notes(index, r), d.notes, { visible: false });
    await humanSleep();
  }
  return skipped;
}

async function handleFillFooter(profile, basicInfo = {}) {
  const S = profile.sel;
  await setWarekiDate(S.deliveryDate, basicInfo.explainDate);
  await fillInput(S.explainer, basicInfo.explainer);
}

// =============================================================
// 障害（inline）: 1回の呼び出しで「1フェーズだけ」進める
// 【重要】サービスをインラインポップアップで「保存する」とページ全体が再読み込みされ、
// content.jsごと破棄される（=1メッセージで全処理すると通信チャネルが切れる）。
// そのため要介護と同様に、backgroundがRUN_ALLを繰り返し呼び、こちらは毎回
//   ・未保存サービスがあれば1件だけ入力→（応答を返した後）保存
//   ・全部保存済みなら契約支給量・援助内容・説明日を入れて完了
// と進める。入力済みサービスは週間計画表の行テキスト（時間帯・提供日）で自動判定する。
// =============================================================

// ラベル行のラジオボタンを表示テキストで選ぶ（移動支援の「サービス内容」など、selectではなくradioの項目用）
async function selectLabeledRadio(labelText, optionText, onSkip) {
  const nt = norm(labelText), no = norm(optionText);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const cells = [...document.querySelectorAll('th, td')]
      .filter((t) => !t.querySelector('input,select') && norm(t.textContent).includes(nt))
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    for (const cell of cells) {
      const row = cell.closest('tr');
      const radios = row ? [...row.querySelectorAll('input[type="radio"]')] : [];
      for (const r of radios) {
        const lb = r.id ? row.querySelector(`label[for="${r.id}"]`) : null;
        const txt = (lb ? lb.textContent : '') || (r.parentElement ? r.parentElement.textContent : '');
        if (norm(txt).includes(no)) {
          await humanSleep(); safeClick(r);
          r.dispatchEvent(new Event('change', { bubbles: true }));
          await humanSleep();
          return true;
        }
      }
    }
    await sleep(300);
  }
  console.warn(`「${labelText}」のラジオ「${optionText}」が見つからずスキップ`);
  if (onSkip) onSkip(`${labelText}（「${optionText}」が見つからない）`);
  return false;
}

// 障害ポップアップの開始・終了時間を入力する。
// 保険内（居宅介護・重度訪問介護）＝4桁テキスト欄、保険外（移動支援）＝時/分/分のselect×6（実機確認 7/15）
async function fillShogaiTimes(P, svc, onSkip) {
  const st = String(svc.startTime || ''), et = String(svc.endTime || '');
  if (!st && !et) return;
  try {
    await waitForElement(P.startTime, { timeout: 3000 });
    await fillInput(P.startTime, toHHMM(st));
    await fillInput(P.endTime, toHHMM(et));
    return;
  } catch (_) { /* テキスト欄なし → select型（保険外） */ }
  const s3 = splitTime3(st), e3 = splitTime3(et);
  const nt = norm('開始・終了時間');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const cell = [...document.querySelectorAll('th, td')]
      .filter((t) => !t.querySelector('select') && norm(t.textContent).includes(nt))
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
    const row = cell && cell.closest('tr');
    const sels = row ? [...row.querySelectorAll('select')] : [];
    if (sels.length >= 6 && s3 && e3) {
      const vals = [s3.hour, s3.min1, s3.min2, e3.hour, e3.min1, e3.min2];
      for (let i = 0; i < 6; i++) { await humanSleep(); pickOption(sels[i], vals[i], '「開始・終了時間」'); }
      return;
    }
    await sleep(300);
  }
  console.warn('開始・終了時間の欄が見つからずスキップ');
  if (onSkip) onSkip('開始・終了時間（欄が見つからない）');
}

// 障害ポップアップの「登録する」を確実に押す。
// このボタン（input type="image"）の onclick は bizFunction() 内で同期ajaxのセッション確認を行い、
// それが失敗するとクリックが無言で不発になる（実HTML解析 7/15）。そのためリトライを行い、
// 送信された（＝ボタンが消えた/隠れた）ことを確認する。2回失敗しても popupStuck 検知が後始末する。
async function clickShogaiRegist(el) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { safeClick(el); } catch (e) { console.warn('「登録する」クリック失敗:', e && e.message); }
    console.log(`[kaipoke-autofill] サービス設定の「登録する」をクリック（試行${attempt}）`, el && el.id);
    await sleep(2500);
    const rc = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (!document.contains(el) || !rc || rc.width === 0 || rc.height === 0) return; // 送信された
  }
}

// 【v2.11.0】保険外の合成POST送信（submitShogaiRegistForm）は撤去した。
// popupSubmitId=1やregist.xを自前で組み立てて form.submit() する処理は「人がボタンを押す
// 画面操作」を超えており、社内遵守事項に照らして行わない。保険外（移動支援）はそもそも
// 自動登録の対象外（人が手動登録）。保険内サービスの保存は実際の「登録する」ボタンの
// クリック（clickShogaiRegist）のみで行う。

// 【v2.9.9】「保存操作済み」のsessionStorage署名記録は廃止した。
// もともと保険外（移動支援）が週間計画表に出ないための仕組みだったが、保険外を自動登録の
// 対象外にしたため不要になり、むしろ「同じタブで別の計画書を開くと前の計画書の記録が
// 効いてサービス登録を全部スキップする」誤爆（キーが計画書タイトル＝利用者名で衝突）を
// 起こしていた。入力済み判定は週間計画表の実際の行（svcAlreadyEntered）のみで行う。
// 保存が反映されない場合はbackgroundの「remaining非減少」ガードが停止して人に知らせる。

// 移動支援（保険外）の登録済み件数を、この計画書ごとに sessionStorage で数える。
// 保険外サービスは【保険内】タブの週間計画表に出ず、援助内容タブの見え方も画面状態で
// 変わるため、DOMだけでは登録済み数を確実に数えにくい。そこで「登録するボタンを押した回数」を
// 計画書の内部ID（homeCareEtcPlanInternalId・利用者/計画ごとに一意）をキーにして記録する。
// ※旧sig方式はキーが計画書タイトル（利用者名）で別計画書と衝突したが、これは内部IDキーで衝突しない。
function getPlanId() {
  const el = document.querySelector('[onclick*="homeCareEtcPlanInternalId"]');
  if (el) {
    const m = (el.getAttribute('onclick') || '').match(/homeCareEtcPlanInternalId['"]?\s*:\s*['"]?(\d+)/);
    if (m) return m[1];
  }
  const hid = document.querySelector('input[name*="omeCareEtcPlanInternalId"], input[id*="omeCareEtcPlanInternalId"]');
  if (hid && hid.value) return hid.value;
  return 'default';
}
const idouCounterKey = () => 'kaipokeIdouDone:' + getPlanId();
function getIdouDone() { try { return parseInt(sessionStorage.getItem(idouCounterKey()) || '0', 10) || 0; } catch (_) { return 0; } }
function bumpIdouDone() { try { sessionStorage.setItem(idouCounterKey(), String(getIdouDone() + 1)); } catch (_) {} }

// 週間計画表の行テキストと照合して、このサービスが入力済みかを判定（backgroundの判定と同じロジック）
function svcAlreadyEntered(existingRows, svc) {
  const st = String(svc.startTime || ''), et = String(svc.endTime || '');
  const days = svc.provisionDays || [];
  if (!st) return false;
  return existingRows.some((e) => {
    const t = String(e.text || '');
    if (t.indexOf(st) < 0) return false;
    if (et && t.indexOf(et) < 0) return false;
    return days.every((d) => t.indexOf(d) >= 0);
  });
}

async function runShogai(profile, payload) {
  const S = profile.sel, P = profile.popupSel;
  const basic = payload.basicInfo || {}, services = Array.isArray(payload.services) ? payload.services : [];
  const skipped = []; // 自動選択できなかった項目（完了メッセージで利用者に知らせる）

  // 前回の「登録する」が完了しておらずインラインポップアップが開いたままなら、
  // 同じ入力を繰り返さずに停止して人に知らせる（未入力の必須項目やバリデーションエラーの可能性）。
  // ※保険外モードではサービス種類欄が「分類」に差し替わるため、特定要素ではなく
  //   disableFormPopup配下のいずれかが表示中かどうかで「開いている」を判定する。
  const isPopupOpen = () => [...document.querySelectorAll('[id^="disableFormPopup"]')].some((el) => {
    const rc = el.getBoundingClientRect();
    return rc.width > 0 && rc.height > 0;
  });
  if (isPopupOpen()) {
    // 保存のajax処理中の可能性もあるため、閉じるのを少し待ってから判定する
    const deadline = Date.now() + 8000;
    while (isPopupOpen() && Date.now() < deadline) await sleep(500);
    if (isPopupOpen()) {
      // カイポケがポップアップ内に出している赤字のバリデーションエラーを拾って人に見せる
      const errTexts = [...document.querySelectorAll('font[color], .err, .error, .errmsg, .txt-error, span[style*="color"], div[style*="color"]')]
        .filter((e) => { const rc = e.getBoundingClientRect(); return rc.width > 0 && rc.height > 0; })
        .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t && t.length <= 200);
      return { phase: 'popupStuck', errors: [...new Set(errTexts)].slice(0, 5) };
    }
  }

  const existingRows = getExistingServices();
  // 保険内（居宅介護等）と保険外（移動支援）を分ける。登録は保険内→保険外の順で行う
  // （保険外は保険内が計画書に載ってから追加する。保険外は「保険内タブ」の週間計画表には出ないため、
  //  登録済み数は援助内容の「サービスN」タブ数＝#idTabService li で数える／実クリックのみで実装）。
  const isIdouSvc = (svc) => String(svc.serviceType || '').indexOf('移動支援') >= 0 || svc.insuranceType === '保険外';
  const nonIdou = services.filter((svc) => !isIdouSvc(svc)); // 保険内（登録順＝JSON順）
  const idouSvcs = services.filter(isIdouSvc);               // 保険外＝移動支援（登録順）
  const orderedServices = [...nonIdou, ...idouSvcs];          // 実際の登録順＝援助内容タブの並び順
  const pending = nonIdou.filter((svc) => !svcAlreadyEntered(existingRows, svc)); // 未登録の保険内
  // 保険外（移動支援）の登録済み数は、計画書ごとのカウンタ（「登録する」を押した回数）で数える。
  // 保険内が全て載ってから移動支援に進む（pendingがある間は0扱い）。
  const idouDone = pending.length ? 0 : getIdouDone();
  const idouPending = idouSvcs.slice(idouDone);
  console.log('[kaipoke-autofill] 既存行:', existingRows.map((e) => e.text), '未処理(保険内):', pending.length, '移動支援 登録済:', idouDone, '/', idouSvcs.length);

  // ① 基本情報＋援助目標（入力済みサービスが無い＝初回のみ）
  if (!existingRows.length) {
    // 入力前に基本情報が「空だった」か記録する（今回このrunで初めて入れたかの判定に使う）
    const goalEl = document.querySelector(S.assistanceGoal);
    const wasEmpty = !(goalEl && String(goalEl.value || '').trim());
    // 作成年月日（必須欄）：JSONの作成日を入れる。解釈できない場合は実行日（今日）
    await setWarekiDate(S.createdDate, basic.createdDate, { fallbackToday: true });
    await fillInput(S.author, basic.author);
    await fillInput(S.hopePerson, basic.personFamilyHope || basic.hopePerson);
    await fillInput(S.assistanceGoal, basic.assistanceGoal || basic.longTermGoal);
    // 契約支給量も基本情報と一緒に入れて、まとめて人が「登録する」で保存する
    await fillContractQuantities(S, services, skipped);

    const anyToAdd = pending.length || idouPending.length; // 追加するサービスが保険内/移動支援いずれかある
    // ② サービス追加ボタンが無い（＝新規画面。保存が先）なら案内して終了
    if (anyToAdd && !(await hasAddServiceButton())) {
      return { phase: 'needSaveFirst' };
    }
    // ②' 編集画面だが基本情報を今回このrunで初めて入れた場合、サービス追加の前に人が保存する。
    //     未保存のままサービス追加ボタン（フォーム送信リンク）を押すと移動確認ダイアログが
    //     出てしまうため（内部関数の書き換えはしない方針）。保存後に再実行すれば続きから進む。
    const hasBasicData = !!(basic.assistanceGoal || basic.longTermGoal || basic.author ||
      basic.personFamilyHope || basic.hopePerson || basic.createdDate);
    if (wasEmpty && hasBasicData && anyToAdd) {
      return { phase: 'needBasicSave' };
    }
  }

  // ③ 未保存サービスがあれば「1件だけ」入力する（保存クリックは呼び出し側＝応答後）
  // 【障害ポップアップの運用ルール 2026/07/14】
  //   保険内: サービス種類=居宅介護/重度訪問介護
  //     居宅介護    : サービス区分=AI解析結果(serviceCategory)
  //     重度訪問介護: サービス区分=「重度訪問介護（障害支援区分６）」固定（修正は手入力）／訪問先=「居宅」固定／移動介護時間=手入力
  //     共通        : 重複=原則「1人目」。派遣人数=2人同時作業(twoPersons)の場合のみ「2人」（通常は「-」のまま触らない）
  //                   資格・運転・深夜の巡回型派遣分離・事業所と同一の建物の利用者減算は触らない
  //   保険外: 【分類】=移動支援／サービス内容=「移動支援0円（1回0円）」／金額は触らない
  // 追加対象を決める：まず保険内（pending）、保険内が全て載ったら移動支援（idouPending）。
  // remaining は「あと何件追加が残っているか」の総数（保険内＋移動支援）で、単調に減るようにする
  // （backgroundの「進んでいない」検知が保険内→保険外の切替でも誤動作しないように）。
  const svcToAdd = pending.length ? pending[0] : (idouPending.length ? idouPending[0] : null);
  const totalRemainingAfter = (pending.length + idouPending.length) - 1;
  if (svcToAdd) {
    const svc = svcToAdd;
    const svcNo = services.indexOf(svc) + 1; // JSON上のサービス番号（1始まり）
    const addBtn = await waitForElement(S.addServiceButton);
    // ここに来る時点で基本情報は保存済み（未保存の変更なし）＝送信リンクを押しても移動確認は出ない
    await humanSleep(); safeClick(addBtn); await humanSleep();
    await waitForElement(P.root); await humanSleep();
    const isIdou = String(svc.serviceType || '').indexOf('移動支援') >= 0 || svc.insuranceType === '保険外';
    await setRadio(isIdou ? P.insuranceOutside : P.insuranceInside);
    await sleep(1000); // 保険区分の切替でフォーム項目が差し替わる（保険外は「分類」欄になる）
    const tag = (label) => `サービス${svcNo}: ${label}`;
    const soft = (label, value) => selectOptionByLabelSoft(label, value, { push: (s) => skipped.push(tag(s)) });
    if (isIdou) {
      await soft('分類', '移動支援');
      await sleep(1000); // 分類選択のajaxでサービス内容ラジオが読み込まれる
      try { await selectOption(P.servicePlant, svc.serviceOffice); }
      catch (e) { skipped.push(tag('サービス事業所（選択肢と不一致）')); console.warn('サービス事業所は選択できずスキップ:', e && e.message); }
      // サービス内容はラジオボタン（selectではない・実機確認 7/15）。「移動支援0円（1回・0円）」を選ぶ
      await selectLabeledRadio('サービス内容', '移動支援0円', (s) => skipped.push(tag(s)));
      await sleep(800); // 金額が自動更新される（金額は触らない）
    } else {
      await selectOption(P.serviceKind, svc.serviceType, { optionTimeout: 20000 }); // 居宅介護/重度訪問介護
      await sleep(1000); // 種類選択のajaxでサービス区分等が出現
      await selectOption(P.servicePlant, svc.serviceOffice, { optionTimeout: 15000 });
      if (String(svc.serviceType || '').indexOf('重度訪問介護') >= 0) {
        await soft('サービス区分', '重度訪問介護（障害支援区分６）');
        await soft('訪問先', '居宅');
      } else {
        // サービス区分は単一選択。AIが「身体介護,家事援助」等と複数返した場合は先頭を採用する
        // （1サービス＝1区分。両方必要なら本来サービスを分ける。区分名を1つに絞れば必須エラー回避）
        const cat = String(svc.serviceCategory || '').split(/[,、，/／・]/)[0].trim();
        if (String(svc.serviceCategory || '').split(/[,、，/／・]/).length > 1) {
          skipped.push(tag(`サービス区分は「${cat}」を採用（JSONに複数「${svc.serviceCategory}」→先頭のみ・要目視）`));
        }
        await soft('サービス区分', cat);
      }
      await soft('重複', '1人目');
      if (svc.twoPersons) await soft('派遣人数', '2人');
    }
    // 開始・終了時間（保険内=4桁テキスト／保険外=時・分select×6 の両形式に対応）
    await fillShogaiTimes(P, svc, (s) => skipped.push(tag(s)));
    for (const d of (svc.provisionDays || [])) await setCheckbox(P.checkedDay(d), true);
    // 保存ボタン（保険外＝自立支援ポップアップは「登録する」表記でidも異なる場合がある。
    // idで見つからなければ、ポップアップ内（disableFormPopup配下）から文言の部分一致で探す）
    let regist = null;
    try { regist = await waitForElement(P.regist, { timeout: 4000 }); } catch (_) {}
    if (!regist) {
      regist = [...document.querySelectorAll('a, button, input[type="button"], input[type="submit"], img')].find((e) => {
        if (!e.closest('[id^="disableFormPopup"]')) return false; // メイン画面の「登録する」を誤爆しない
        const t = ((e.value || '') + ((e.getAttribute && e.getAttribute('alt')) || '') + (e.textContent || '')).replace(/[\s　]/g, '');
        return t.indexOf('登録する') >= 0 || t.indexOf('保存する') >= 0;
      }) || null;
    }
    if (!regist) throw new Error('サービス設定の保存（登録する）ボタンが見つかりませんでした。ポップアップを×で閉じてから、この画面のスクショをシステム部に送ってください。');
    await humanSleep();
    return { phase: 'service', registEl: regist, svcNo, remaining: totalRemainingAfter, skipped, isIdou, kind: isIdou ? '移動支援' : '保険内' };
  }

  // ④ 全サービス保存済み → 援助内容（サービスNタブごと）→ 説明日
  // 【v2.11.0】障害の援助内容は「サービスN」タブ式（実HTML: div#idTabService）。
  // タブ切替（oamSubmitFormのフル送信）だけでは前タブの入力が保存されず消えるため、
  // 【1タブ入力するごとに人が「登録する」で保存する】運用にする（ユーザー指示 7/15）。
  //   ・表示中タブが未入力 → そのタブを入力して停止（supportFilled）＝人が「登録する」→再実行
  //   ・表示中タブが入力済み → 次の（明細のある）タブへ切替（supportSwitch）。保存済みで
  //     未保存の変更が無いので、タブ送信リンクを押しても移動確認ダイアログは出ない。
  //   ・後続タブが全て入力済み → 説明日を入れて done
  // タブk = orderedServices[k]（保険内→移動支援の登録順）。
  // 【運用ルール 2026/07/16】保険外（移動支援）は援助内容を入力しない（ユーザー指示）。
  //   → 保険外サービスのタブは needsSupport=false としてスキップする。
  const needsSupport = (svc) => svc && !isIdouSvc(svc) && (svc.supportDetails || []).length > 0;
  const tabs = [...document.querySelectorAll('#idTabService li')];

  if (tabs.length) {
    const activeIdx = Math.max(0, tabs.findIndex((li) => String(li.className || '').indexOf('tab-on') >= 0));
    const cur = orderedServices[activeIdx];
    // 表示中タブが未入力なら、入力して停止（人が「登録する」で保存）
    if (needsSupport(cur) && !supportTabFilled(S, cur)) {
      await fillShogaiSupportTab(S, cur, activeIdx, skipped);
      return { phase: 'supportFilled', tabNo: activeIdx + 1, skipped };
    }
    // 表示中タブは済み（or 明細なし・保険外）→ 次の入力が必要なタブへ切替
    for (let k = activeIdx + 1; k < Math.min(tabs.length, orderedServices.length); k++) {
      if (!needsSupport(orderedServices[k])) continue;
      const a = tabs[k].querySelector('a') || tabs[k];
      return { phase: 'supportSwitch', tabEl: a, next: k + 1, skipped };
    }
  } else if (services.some(needsSupport)) {
    // タブが無い＝サービス未登録の画面等。旧フラット方式は誤入力のもとなので入力しない
    skipped.push('援助内容: サービスタブが見つからないためスキップしました（サービス登録後に再実行してください）');
  }

  // 説明日（作成状態・最終登録は人間）
  await setWarekiDate(S.deliveryDate, basic.explainDate);
  return { phase: 'done', count: services.length, skipped };
}

// 契約支給量（form:loop:N:contractSupplyQuantity）を入力する。数値（時間/月）のみ書き込む。
async function fillContractQuantities(S, services, skipped) {
  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    if (!svc.contractSupplyQuantity) continue;
    const q = z2h(String(svc.contractSupplyQuantity)).trim();
    if (/^[0-9]+(\.[0-9]+)?$/.test(q)) {
      try { await fillInput(S.supplyQty(i), q, { timeout: 5000, visible: false }); } catch (_) {}
    } else {
      skipped.push(`契約支給量（${i + 1}行目）: 「${svc.contractSupplyQuantity}」は数値でないため未入力（手動で時間数を入れてください）`);
    }
  }
}

// 表示中の援助内容タブが、そのサービスの明細で既に埋まっているか（所要時間・本人家族欄で判定）
function supportTabFilled(S, svc) {
  const details = svc.supportDetails || [];
  if (!details.length) return true;
  return details.every((d, r) => {
    const t = document.querySelector(S.support.time(r));
    const h = document.querySelector(S.support.hope(r));
    const timeOk = !d.requiredTime || (t && String(t.value).trim() === String(d.requiredTime).trim());
    const hopeOk = !d.content || (h && String(h.value).trim() === String(d.content).trim());
    return timeOk && hopeOk;
  });
}

// テキスト/テキストエリアに値を入れて blur を発火し、カイポケのonblurのajax（ajaxSingle）で
// その1項目をサーバー側に確定させる。障害の援助内容は区分selectの変更で行テーブル全体が
// ajax再描画されるため、blur未発火のままだと後の再描画で入力が消える（v2.9.9以前の
// 「先頭行が空白になる」の原因）。値が同じ場合は触らない（不要なajaxを起こさない）。
async function setTextPersist(selector, value) {
  const el = document.querySelector(selector);
  if (!el) return false;
  const v = (value === undefined || value === null) ? '' : String(value);
  if (String(el.value || '') === v) return true;
  setNativeValue(el, v);
  el.dispatchEvent(new FocusEvent('blur'));
  await sleep(700); // blurのajax完了を待つ
  return true;
}

// 表示中の「サービスN」タブに、そのサービスの援助内容（supportDetails）を入力する。
// 順序が重要: 区分select（onchange→行テーブル全体を再描画）→待つ→項目select（ajax）→待つ→
// テキスト3欄（blurで1項目ずつ確定）。要素参照は毎回セレクタで取り直す（再描画で差し替わるため）。
async function fillShogaiSupportTab(S, svc, tabIdx, skipped) {
  const details = svc.supportDetails || [];
  const tag = `援助内容(サービス${tabIdx + 1})`;
  // 既にこのタブへ入力済みなら触らない（人の修正を上書きしない）
  const already = details.length && details.every((d, r) => {
    const t = document.querySelector(S.support.time(r));
    const h = document.querySelector(S.support.hope(r));
    const timeOk = !d.requiredTime || (t && String(t.value).trim() === String(d.requiredTime).trim());
    const hopeOk = !d.content || (h && String(h.value).trim() === String(d.content).trim());
    return timeOk && hopeOk;
  });
  if (already) return;
  for (let r = 0; r < details.length; r++) {
    const d = details[r];
    if (!document.querySelector(S.support.time(r))) {
      skipped.push(`${tag}${r + 1}行目以降（${details.length - r}件分）: 入力行が足りないためスキップ（手動で入力してください）`);
      break;
    }
    const rowTag = `${tag}${r + 1}行目`;
    if (d.category) {
      try { await selectOption(S.support.division(r), d.category, { visible: false, optionTimeout: 2000 }); await sleep(1200); }
      catch (_) { skipped.push(`${rowTag}: 区分「${d.category}」が選択肢に無いためスキップ`); }
    }
    if (d.item) {
      try { await selectOption(S.support.item(r), d.item, { visible: false, optionTimeout: 2500 }); await sleep(800); }
      catch (_) {
        try {
          await selectOption(S.support.item(r), 'その他', { visible: false, optionTimeout: 2000 }); await sleep(800);
          skipped.push(`${rowTag}: 項目「${d.item}」が選択肢に無いため「その他」で代用`);
        } catch (_) { skipped.push(`${rowTag}: 項目「${d.item}」が選択できずスキップ`); }
      }
    }
    await setTextPersist(S.support.time(r), d.requiredTime);
    await setTextPersist(S.support.notes(r), d.notes);
    await setTextPersist(S.support.hope(r), d.content);
  }
  // 明細より後ろの行に残っている値（旧バージョンが詰め込んだ他サービスの明細など）を消す
  for (let r = details.length; ; r++) {
    if (!document.querySelector(S.support.time(r))) break;
    for (const k of ['division', 'item']) {
      const el = document.querySelector(S.support[k](r));
      if (el && el.value) { setNativeValue(el, ''); await sleep(1000); }
    }
    for (const k of ['time', 'notes', 'hope']) await setTextPersist(S.support[k](r), '');
  }
}

// =============================================================
// 役割判定・メッセージ受信
// =============================================================
const PROFILE = detectProfile();

// 別ウィンドウ型サービスポップアップ（介護 MEM093104）は background に準備完了を通知
if (PROFILE && PROFILE.isServicePopup) {
  const announce = () => chrome.runtime.sendMessage({ type: 'POPUP_READY' }, () => void chrome.runtime.lastError);
  if (document.readyState === 'complete') announce();
  else window.addEventListener('load', announce);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.cmd) return;
  (async () => {
    try {
      if (!PROFILE) throw new Error('この画面は対応する計画書ページとして認識できませんでした。');
      switch (message.cmd) {
        case 'GET_MODE':
          sendResponse({ ok: true, mode: PROFILE.mode, label: PROFILE.label });
          return;
        case 'RUN_ALL': { // 障害（inline）: 1フェーズだけ進めて応答する（backgroundが繰り返し呼ぶ）
          const result = await runShogai(PROFILE, message.payload);
          if (result.phase === 'service') {
            // 保険内サービスの保存クリックでページ全体が再読み込みされ応答チャネルが切れるため、
            // 先に応答を返してから実際の「登録する」ボタンをクリックする
            sendResponse({ ok: true, phase: 'service', svcNo: result.svcNo, remaining: result.remaining, kind: result.kind || '', skipped: result.skipped || [] });
            // 移動支援は「登録するを押した回数」を計画書ごとに記録し、再実行時に登録済みをスキップする
            // （保険外は週間計画表(保険内タブ)に出ないためDOMで数えられない。ページ遷移前に先に記録）
            if (result.kind === '移動支援') bumpIdouDone();
            await humanSleep();
            await clickShogaiRegist(result.registEl);
            return;
          }
          if (result.phase === 'supportSwitch') {
            // 援助内容タブの切替はフォーム全体の再送信＝画面遷移になり応答チャネルが切れるため、
            // 先に応答を返してからタブをクリックする（backgroundが再読み込みを待って続行する）。
            // このタブは保存済み（未保存の変更なし）でクリックするので移動確認ダイアログは出ない。
            sendResponse({ ok: true, phase: 'supportSwitch', next: result.next, skipped: result.skipped || [] });
            await humanSleep(); safeClick(result.tabEl);
            return;
          }
          sendResponse({ ok: true, phase: result.phase, count: result.count || 0, tabNo: result.tabNo || 0, skipped: result.skipped || [], manualIdou: result.manualIdou || [], errors: result.errors || [] });
          return;
        }
        case 'HAS_ADD_BUTTON': sendResponse({ ok: true, has: await hasAddServiceButton() }); return;
        case 'GET_EXISTING_SERVICES': sendResponse({ ok: true, services: getExistingServices() }); return;
        case 'SELECT_SUPPORT_TAB': {
          const tab = findSupportTab(message.number);
          if (!tab) throw new Error('援助内容の「サービス' + message.number + '」タブが見つかりませんでした。');
          const li = tab.closest('li');
          if (li && String(li.className || '').indexOf('tab-on') >= 0) {
            sendResponse({ ok: true, navigated: false }); // 既に選択済み。クリック不要
            return;
          }
          // タブクリックはページ全体の再送信（画面遷移）になり応答チャネルが切れるため、先に応答を返す
          sendResponse({ ok: true, navigated: true });
          await humanSleep(); safeClick(tab);
          return;
        }
        case 'FILL_BASIC': await handleFillBasic(PROFILE, message.basicInfo); break;
        case 'OPEN_SERVICE_MODAL': await handleOpenServiceModal(PROFILE, message.insuranceType); break;
        case 'FILL_SERVICE': {
          const r = await handleFillServiceKaigo(PROFILE, message.service, message.basicInfo || {}, !!message.isYoshien);
          // 保存クリックでこのウィンドウ自体が閉じて応答チャネルが切れるため、先に応答を返す
          sendResponse({ ok: true, skipped: r.skipped });
          safeClick(r.regist); // 保存→成功時ウィンドウは自動で閉じ、親画面がrefreshされる
          return;
        }
        case 'FILL_SUPPORT': {
          const supSkipped = await handleFillSupport(PROFILE, message.index, message.supportDetails);
          sendResponse({ ok: true, skipped: supSkipped || [] });
          return;
        }
        case 'FILL_FOOTER': await handleFillFooter(PROFILE, message.basicInfo); break;
        default: throw new Error('未知のコマンド: ' + message.cmd);
      }
      sendResponse({ ok: true });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      alert('カイポケ自動入力を安全に停止しました。\n\n理由：' + msg +
        '\n\n画面のレイアウトが変わった可能性があります。\nシステム部にセレクタ（PROFILES）の確認を依頼してください。');
      sendResponse({ ok: false, message: msg });
    }
  })();
  return true;
});
