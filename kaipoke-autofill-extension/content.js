// content.js（v4：計画書3種すべて実DOM反映）
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
    match: ['MEM093151', 'MEM093103'],
    mode: 'window',
    servicePopupMatch: 'MEM093104',
    isYoshien: false,
    sel: mainSelKaigo(false),
    popupSel: popupSel093104(),
  },
  // ---------- 要支援 介護予防訪問介護計画書 ----------
  youshien: {
    label: '要支援 介護予防訪問介護計画書',
    match: ['MEM093155'],
    mode: 'window',
    servicePopupMatch: 'MEM093104',
    isYoshien: true,
    sel: mainSelKaigo(true),
    popupSel: popupSel093104(),
  },
  // ---------- 障害 居宅介護等計画書 ----------
  shogai: {
    label: '障害 居宅介護等計画書',
    match: ['MEM083101', 'MEM083103'],
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
  await humanSleep(); setNativeValue(el, String(value)); await humanSleep();
}

async function selectOption(selector, value, options = {}) {
  if (value === undefined || value === null || value === '') return;
  const el = await waitForElement(selector, options);
  await humanSleep();
  const target = String(value).trim();
  let matched = null;
  for (const opt of Array.from(el.options || [])) {
    if (opt.value === target || opt.textContent.trim() === target) { matched = opt; break; }
  }
  if (!matched) for (const opt of Array.from(el.options || [])) { if (opt.textContent.trim().includes(target)) { matched = opt; break; } }
  if (!matched) throw new Error(`選択肢が見つかりません: "${selector}" に「${target}」なし（カイポケ登録値と不一致の可能性）。`);
  setNativeValue(el, matched.value); await humanSleep();
}

async function setRadio(selector, options = {}) {
  const el = await waitForElement(selector, options);
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

async function setWarekiDate(dateSelectors, warekiStr, options = {}) {
  if (!warekiStr || !dateSelectors) return;
  const p = parseWareki(warekiStr);
  if (!p) throw new Error(`和暦日付の解釈に失敗: "${warekiStr}"（例: 令和8年7月13日）`);
  await selectOption(dateSelectors.era, p.era, options);
  await selectOption(dateSelectors.year, p.year, options);
  await selectOption(dateSelectors.month, p.month, options);
  await selectOption(dateSelectors.day, p.day, options);
}
function parseWareki(s) {
  const m = String(s).match(/^\s*(明治|大正|昭和|平成|令和)\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日\s*$/);
  return m ? { era: m[1], year: m[2], month: m[3], day: m[4] } : null;
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
  await setWarekiDate(S.createdDate, basicInfo.createdDate);
  await selectOption(S.insuredProof, basicInfo.insurancePeriod);
  await fillInput(S.author, basicInfo.author);
  if (S.communityGeneralSc) await selectOption(S.communityGeneralSc, basicInfo.communityGeneralSc);
  await selectOption(S.careOffice, basicInfo.careOffice);
  await selectOption(S.careManager, basicInfo.careManager);
  await fillInput(S.issues, basicInfo.issues);
  await fillInput(S.longTerm, basicInfo.longTermGoal);
  await fillInput(S.shortTerm, basicInfo.shortTermGoal);
  await fillInput(S.hopePerson, basicInfo.personFamilyHope);
  await fillInput(S.notes, basicInfo.notes);
}

async function handleOpenServiceModal(profile) {
  const btn = await waitForElement(profile.sel.serviceActButton);
  await humanSleep(); safeClick(btn); await humanSleep(); // 別ウィンドウが開く
}

// ポップアップ（MEM093104）側のフォーム入力
async function handleFillServiceKaigo(profile, service = {}) {
  const P = profile.popupSel;
  await waitForElement(P.root); await humanSleep();
  await setRadio(service.insuranceType === '保険外' ? P.insuranceOutside : P.insuranceInside);
  await selectOption(P.serviceKind, service.serviceType);   // ajaxでサービス内容が読み込まれる
  await sleep(1000);
  await selectOption(P.servicePlant, service.serviceOffice);
  await selectServiceContentRadio(P.serviceContentBox, service.serviceContent);
  await fillInput(P.unit, service.units);
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
  await humanSleep(); safeClick(regist); await humanSleep(); // 保存→成功時ウィンドウは自動で閉じ、親画面がrefreshされる
}

// 援助内容（listDetail:{S}）に行を入力
async function handleFillSupport(profile, index, supportDetails = []) {
  const S = profile.sel.support;
  const max = S.maxRows || supportDetails.length;
  for (let i = 0; i < supportDetails.length && i < max; i++) {
    const d = supportDetails[i], r = i + 1; // 行は1始まり
    if (d.category) await selectOption(S.division(index, r), d.category, { visible: false });
    if (d.item) await selectOption(S.item(index, r), d.item, { visible: false });
    if (d.content) await fillInput(S.content(index, r), d.content, { visible: false });
    if (d.requiredTime) await fillInput(S.time(index, r), d.requiredTime, { visible: false });
    if (d.notes) await fillInput(S.notes(index, r), d.notes, { visible: false });
    await humanSleep();
  }
}

async function handleFillFooter(profile, basicInfo = {}) {
  const S = profile.sel;
  await setWarekiDate(S.deliveryDate, basicInfo.explainDate);
  await fillInput(S.explainer, basicInfo.explainer);
}

// =============================================================
// 障害（inline）: ページ内で全処理を完結
// =============================================================
async function runShogai(profile, payload) {
  const S = profile.sel, P = profile.popupSel;
  const basic = payload.basicInfo || {}, services = Array.isArray(payload.services) ? payload.services : [];

  // ① 基本情報＋援助目標（区分・相談支援事業所は障害では無いのでスルー）
  await setWarekiDate(S.createdDate, basic.createdDate);
  await fillInput(S.author, basic.author);
  await fillInput(S.hopePerson, basic.personFamilyHope || basic.hopePerson);
  await fillInput(S.assistanceGoal, basic.assistanceGoal || basic.longTermGoal);

  // ② サービスごとにインラインポップアップで追加
  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    const addBtn = await waitForElement(S.addServiceButton);
    await humanSleep(); safeClick(addBtn); await humanSleep();
    await waitForElement(P.root); await humanSleep();
    await setRadio(svc.insuranceType === '保険外' ? P.insuranceOutside : P.insuranceInside);
    await selectOption(P.serviceKind, svc.serviceType);
    await selectOption(P.servicePlant, svc.serviceOffice);
    // 障害の時間欄はテキスト・4桁（入力例 0900〜1400）。"08:15"→"0815" に正規化して入力。
    await fillInput(P.startTime, toHHMM(svc.startTime));
    await fillInput(P.endTime, toHHMM(svc.endTime));
    for (const d of (svc.provisionDays || [])) await setCheckbox(P.checkedDay(d), true);
    const regist = await waitForElement(P.regist);
    await humanSleep(); safeClick(regist); await sleep(1200); await humanSleep();
    // 契約支給量（障害のみ）
    if (svc.contractSupplyQuantity) {
      try { await fillInput(S.supplyQty(i), svc.contractSupplyQuantity, { timeout: 5000, visible: false }); } catch (_) {}
    }
  }

  // ③ 援助内容（フラット form:service:N）に全サービスの明細を順に入力
  const details = [];
  services.forEach((svc) => (svc.supportDetails || []).forEach((d) => details.push(d)));
  for (let r = 0; r < details.length; r++) {
    const d = details[r];
    if (!document.querySelector(S.support.time(r))) {
      const addRow = document.querySelector(S.addSupportRow);
      if (addRow) { await humanSleep(); safeClick(addRow); await sleep(1000); }
    }
    if (d.category) await selectOption(S.support.division(r), d.category, { visible: false });
    if (d.item) await selectOption(S.support.item(r), d.item, { visible: false });
    if (d.requiredTime) await fillInput(S.support.time(r), d.requiredTime, { visible: false });
    if (d.notes) await fillInput(S.support.notes(r), d.notes, { visible: false });
    if (d.content) await fillInput(S.support.hope(r), d.content, { visible: false });
    await humanSleep();
  }

  // ④ 説明日（作成状態・最終登録は人間）
  await setWarekiDate(S.deliveryDate, basic.explainDate);
  return { count: services.length };
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
        case 'RUN_ALL': { // 障害（inline）
          const result = await runShogai(PROFILE, message.payload);
          sendResponse({ ok: true, message: `サービス ${result.count} 件の下書き入力が完了しました。` });
          return;
        }
        case 'FILL_BASIC': await handleFillBasic(PROFILE, message.basicInfo); break;
        case 'OPEN_SERVICE_MODAL': await handleOpenServiceModal(PROFILE); break;
        case 'FILL_SERVICE': await handleFillServiceKaigo(PROFILE, message.service); break;
        case 'FILL_SUPPORT': await handleFillSupport(PROFILE, message.index, message.supportDetails); break;
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
