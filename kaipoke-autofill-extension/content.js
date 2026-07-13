// content.js（v3：計画書3種対応 / 障害は実DOM反映済み）
// カイポケ計画書の自動入力コアロジック。計画書は3種類あり、URLで判定して振る舞う。
//
//   ・要介護  訪問介護計画書       : メイン MEM093151 / サービス設定ポップアップ 別ウィンドウ MEM093104
//   ・要支援  訪問介護計画書       : メイン MEM093155 / サービス設定ポップアップ 別ウィンドウ MEM093104
//   ・障害    居宅介護等計画書     : メイン MEM083101（新規）/ MEM083103（編集）
//              → サービス設定は【同一ページ内のインラインポップアップ】(disableFormPopup:*)。別ウィンドウではない。
//
// 【コンプライアンス】（claude.md）
//   - 内部API直叩き（fetch/XHR）は行わない。純粋なDOM操作のみ。
//   - すべてのアクション間に humanSleep()（500〜1500ms）。JSFはajax再描画が入るため待機は特に重要。
//   - waitForElement は必ずタイムアウト（既定10秒）。失敗時は安全停止＋alert。
//   - セレクタは PROFILES に集約（ハードコード禁止）。
//
// 【実装状況】
//   - 障害（MEM083101/083103）: 添付HTMLの実DOMから selector を反映（要ライブ検証）。
//   - 要介護/要支援（MEM093151/093155 + 093104ポップアップ）: 実HTML未入手のため selector はプレースホルダ。
//   - カイポケUI変更時は PROFILES のみ修正すれば復旧できる構造を維持する。

// =============================================================
// PROFILES — 計画書種別ごとのセレクタ集約
//   JSFのidはコロン(:)を含むため、CSSでは属性セレクタ [id="..."] を使う（コロンのエスケープ不要）。
//   画像ボタンは alt 属性で指定する。
// =============================================================
const PROFILES = {
  // ---------------------------------------------------------
  // 障害福祉サービス「居宅介護等計画書」 ★実DOM反映済み
  //   ・区分（要介護度）や相談支援事業所の紐づけは無い → 該当項目はスルー（JSON側も持たない）
  //   ・サービス設定はインラインポップアップ（同一document）
  //   ・援助内容は「サービスごとのタブ」ではなく form:service:0..N の単一テーブル（フラット）
  // ---------------------------------------------------------
  shogai: {
    label: '障害（居宅介護等計画書）',
    match: ['MEM083101', 'MEM083103'],
    mode: 'inline',                 // サービス設定は同一ページ内
    sel: {
      // 基本情報
      createdDate: { era: '[id="form:makeYmdEra"]', year: '[id="form:makeYmdYear"]', month: '[id="form:makeYmdMonth"]', day: '[id="form:makeYmdDay"]' },
      author: '[id="form:planMakePersonId"]',        // 計画作成者氏名（text）
      // 援助目標（障害は 本人・家族の希望 と 援助目標 の2つ）
      hopePerson: '[id="form:hopePerson"]',           // 本人・家族の希望（textarea）
      assistanceGoal: '[id="form:assistanceGoal"]',   // 援助目標（textarea）
      // 契約支給量テーブル（form:loop:N）。serviceSubjectDivision(種別) と contractSupplyQuantity(支給量)
      supplyRowQty: (n) => `[id="form:loop:${n}:contractSupplyQuantity"]`,
      supplyRowKind: (n) => `[id="form:loop:${n}:serviceSubjectDivision"]`,
      // 援助内容（フラットテーブル form:service:N）
      supportTime: (n) => `[id="form:service:${n}:timeRequire"]`,
      supportDivision: (n) => `[id="form:service:${n}:serviceAlternateDivision"]`,          // サービス区分
      supportItem: (n) => `[id="form:service:${n}:serviceAlternateAssistDivision"]`,        // サービス項目
      supportHeed: (n) => `[id="form:service:${n}:heedPointMatterSubject"]`,                // 留意点
      supportHope: (n) => `[id="form:service:${n}:personAndFamilyAssistance"]`,             // 本人・家族の援助
      addSupportRow: 'input[alt="行を追加する"], img[alt="行を追加する"]',
      // 説明日（deliveryDay）
      deliveryDate: { era: '[id="form:deliveryDayEra"]', year: '[id="form:deliveryDayYear"]', month: '[id="form:deliveryDayMonth"]', day: '[id="form:deliveryDayDay"]' },
      // 作成状態（01=作成中 / 02=作成済）。自動化では触らない（作成中のまま）。
      // 最終「登録する」(alt=登録する, form:j_id...) は人間が押す。自動化では押さない。
      // --- インライン サービス設定ポップアップ ---
      addServiceButton: 'input[alt="新規追加する"], img[alt="新規追加する"]',
      popup: {
        root: '[id="disableFormPopup:serviceKindId"]',   // ポップアップ出現の目印
        insuranceInside: '[id="disableFormPopup:insuranceDivision:0"]',  // value=04
        insuranceOutside: '[id="disableFormPopup:insuranceDivision:1"]', // value=02
        serviceKind: '[id="disableFormPopup:serviceKindId"]',           // サービス種類（select）
        servicePlant: '[id="disableFormPopup:servicePlant"]',           // サービス事業所（select）
        startTime: '[id="disableFormPopup:startTime"]',                 // 開始時間（text 例 08:00）
        endTime: '[id="disableFormPopup:endTime"]',                     // 終了時間（text）
        // 曜日チェック（value 01..07）。index 0..6。※月〜日の割当は要確認（下 WEEKDAY_VALUE）。
        weekday: (v) => `[id="disableFormPopup:checkedDays:${v}"]`,
        regist: 'input[alt="登録する"][id^="disableFormPopup"], [id="disableFormPopup:regist"]', // ポップアップの登録（サービス追加）
      },
    },
  },

  // ---------------------------------------------------------
  // 要介護 訪問介護計画書 … ★実HTML未入手（プレースホルダ）。サービス設定は別ウィンドウ。
  // ---------------------------------------------------------
  youkaigo: {
    label: '要介護（訪問介護計画書）',
    match: ['MEM093151'],
    mode: 'window',
    servicePopupMatch: 'MEM093104',
    sel: {
      createdDate: { era: '#createdDate-era', year: '#createdDate-year', month: '#createdDate-month', day: '#createdDate-day' },
      insurancePeriod: '#insurance-period', author: '#plan-author', careOffice: '#care-office', careManager: '#care-manager',
      issues: '#goal-issues', longTerm: '#goal-long-term', shortTerm: '#goal-short-term', hopePerson: '#goal-hope', notes: '#goal-notes',
      addServiceButton: '#btn-add-service', tabInsurance: '#tab-hokennai', tabOutside: '#tab-hokengai',
      supportTab: '#service-tab-{index}', supportTabContent: '#service-tab-content-{index}',
      supportRows: '.support-row', addSupportRow: '.support-add-row',
      rowCategory: '.support-category', rowItem: '.support-item', rowContent: '.support-content', rowTime: '.support-time', rowNotes: '.support-notes',
      deliveryDate: { era: '#explainDate-era', year: '#explainDate-year', month: '#explainDate-month', day: '#explainDate-day' }, explainer: '#explainer',
      popup: {
        root: '#service-form',
        insuranceInside: 'input[name="hokenKubun"][value="1"]', insuranceOutside: 'input[name="hokenKubun"][value="2"]',
        serviceType: '#service-type', serviceOffice: '#service-office', serviceContent: '#service-content', units: '#service-units',
        startHour: '#start-hour', startMin: '#start-min', endHour: '#end-hour', endMin: '#end-min',
        cycleWeekly: 'input[name="teikyoCycle"][value="weekly"]', cycleNth: 'input[name="teikyoCycle"][value="nth"]',
        weekday: (d) => `input[name="youbi"][value="${d}"]`, saveButton: '#btn-service-save',
      },
    },
  },

  // ---------------------------------------------------------
  // 要支援 訪問介護計画書 … ★実HTML未入手（プレースホルダ）。要介護と同型・メインURLのみ異なる。
  // ---------------------------------------------------------
  youshien: {
    label: '要支援（訪問介護計画書）',
    match: ['MEM093155'],
    mode: 'window',
    servicePopupMatch: 'MEM093104',
    sel: null, // 実装時に youkaigo.sel を基に調整（実HTML入手後）
  },
};
// 要支援は当面 要介護と同じセレクタ想定（実HTML入手後に分離）
PROFILES.youshien.sel = PROFILES.youkaigo.sel;

// 曜日 → チェックボックス value（01..07）の割当。※カイポケ実画面で要確認。
// 暫定: 月=01, 火=02, 水=03, 木=04, 金=05, 土=06, 日=07
const WEEKDAY_VALUE = { '月': '01', '火': '02', '水': '03', '木': '04', '金': '05', '土': '06', '日': '07' };

// URL から適用プロファイルを判定
function detectProfile() {
  const href = location.href;
  for (const key of Object.keys(PROFILES)) {
    const p = PROFILES[key];
    if ((p.match || []).some((m) => href.includes(m))) return { key, ...p };
    if (p.servicePopupMatch && href.includes(p.servicePopupMatch)) return { key, ...p, isServicePopup: true };
  }
  return null;
}

// {index} プレースホルダ埋め込み
function buildSelector(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(params[k]));
}

// =============================================================
// コアスキル（skills.md 準拠）
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
      if (Date.now() - startedAt >= timeout) {
        reject(new Error(`要素が見つかりませんでした（タイムアウト ${timeout}ms）: "${selector}"`));
        return;
      }
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

// 入力ヘルパー
async function fillInput(selector, value, options = {}) {
  if (value === undefined || value === null || value === '') return;
  const el = await waitForElement(selector, options);
  await humanSleep();
  setNativeValue(el, String(value));
  await humanSleep();
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
  if (!matched) {
    for (const opt of Array.from(el.options || [])) {
      if (opt.textContent.trim().includes(target)) { matched = opt; break; }
    }
  }
  if (!matched) throw new Error(`選択肢が見つかりません: "${selector}" に「${target}」が存在しません（カイポケ登録値と不一致の可能性）。`);
  setNativeValue(el, matched.value);
  await humanSleep();
}

async function setRadio(selector, options = {}) {
  const el = await waitForElement(selector, options);
  await humanSleep();
  el.checked = true;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  safeClick(el);
  await humanSleep();
}

async function setCheckbox(selector, checked, options = {}) {
  const el = await waitForElement(selector, options);
  if (el.checked !== !!checked) {
    await humanSleep();
    safeClick(el);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  await humanSleep();
}

async function setWarekiDate(dateSelectors, warekiStr, options = {}) {
  if (!warekiStr || !dateSelectors) return;
  const parsed = parseWareki(warekiStr);
  if (!parsed) throw new Error(`和暦日付の解釈に失敗: "${warekiStr}"（例: 令和8年7月13日）`);
  await selectOption(dateSelectors.era, parsed.era, options);
  await selectOption(dateSelectors.year, parsed.year, options);
  await selectOption(dateSelectors.month, parsed.month, options);
  await selectOption(dateSelectors.day, parsed.day, options);
}
function parseWareki(s) {
  const m = String(s).match(/^\s*(明治|大正|昭和|平成|令和)\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日\s*$/);
  return m ? { era: m[1], year: m[2], month: m[3], day: m[4] } : null;
}

// =============================================================
// 障害（inline）: 全体フローを content.js 内で完結
// =============================================================
async function runShogai(profile, payload) {
  const S = profile.sel;
  const basic = payload.basicInfo || {};
  const services = Array.isArray(payload.services) ? payload.services : [];

  // ① 基本情報＋援助目標（区分・相談支援事業所は障害では無いのでスルー）
  await setWarekiDate(S.createdDate, basic.createdDate);
  await fillInput(S.author, basic.author);
  await fillInput(S.hopePerson, basic.personFamilyHope || basic.hopePerson);
  await fillInput(S.assistanceGoal, basic.assistanceGoal || basic.longTermGoal);

  // ② サービスごとにインラインポップアップで追加
  for (let i = 0; i < services.length; i++) {
    const svc = services[i];

    // 新規追加する → インラインポップアップ表示
    const addBtn = await waitForElement(S.addServiceButton);
    await humanSleep();
    safeClick(addBtn);
    await humanSleep();

    // ポップアップのフォーム出現待機
    await waitForElement(S.popup.root);
    await humanSleep();

    // 保険区分（先に選ぶ：onclickで依存項目がクリアされるため）
    await setRadio(svc.insuranceType === '保険外' ? S.popup.insuranceOutside : S.popup.insuranceInside);
    await selectOption(S.popup.serviceKind, svc.serviceType);
    await selectOption(S.popup.servicePlant, svc.serviceOffice);
    await fillInput(S.popup.startTime, svc.startTime);
    await fillInput(S.popup.endTime, svc.endTime);
    for (const d of (svc.provisionDays || [])) {
      const v = WEEKDAY_VALUE[d];
      if (v) await setCheckbox(S.popup.weekday(v), true);
    }

    // ポップアップの「登録する」でサービスを追加（JSFのajax再描画を待つ）
    const regist = await waitForElement(S.popup.regist);
    await humanSleep();
    safeClick(regist);
    await sleep(1200); // ajax再描画待ち
    await humanSleep();

    // 契約支給量（対応する loop 行に入力）※行順=サービス追加順と仮定
    if (svc.contractSupplyQuantity) {
      try { await fillInput(S.supplyRowQty(i), svc.contractSupplyQuantity, { timeout: 5000 }); }
      catch (_) { /* 行が未生成/対応不明ならスキップ（安全側） */ }
    }
  }

  // ③ 援助内容（フラットテーブル form:service:N）に全サービスの明細を順に入力
  const details = [];
  services.forEach((svc) => (svc.supportDetails || []).forEach((d) => details.push(d)));
  for (let r = 0; r < details.length; r++) {
    const d = details[r];
    // 行が足りなければ「行を追加する」
    if (!document.querySelector(S.supportTime(r))) {
      const addRow = document.querySelector(S.addSupportRow);
      if (addRow) { await humanSleep(); safeClick(addRow); await sleep(1000); }
    }
    if (d.category) await selectOption(S.supportDivision(r), d.category);
    if (d.item) await selectOption(S.supportItem(r), d.item);
    if (d.requiredTime) await fillInput(S.supportTime(r), d.requiredTime);
    if (d.notes) await fillInput(S.supportHeed(r), d.notes);
    if (d.content) await fillInput(S.supportHope(r), d.content);
    await humanSleep();
  }

  // ④ 説明日（作成状態・最終登録は人間）
  await setWarekiDate(S.deliveryDate, basic.explainDate);

  return { count: services.length };
}

// =============================================================
// 要介護/要支援（window）: 個別コマンド（background が順序制御）※プレースホルダ
// =============================================================
async function handleFillBasic(profile, basicInfo = {}) {
  const S = profile.sel;
  await setWarekiDate(S.createdDate, basicInfo.createdDate);
  await selectOption(S.insurancePeriod, basicInfo.insurancePeriod);
  await fillInput(S.author, basicInfo.author);
  await selectOption(S.careOffice, basicInfo.careOffice);
  await selectOption(S.careManager, basicInfo.careManager);
  await fillInput(S.issues, basicInfo.issues);
  await fillInput(S.longTerm, basicInfo.longTermGoal);
  await fillInput(S.shortTerm, basicInfo.shortTermGoal);
  await fillInput(S.hopePerson, basicInfo.personFamilyHope);
  await fillInput(S.notes, basicInfo.notes);
}
async function handleOpenServiceModal(profile, insuranceType) {
  const S = profile.sel;
  const tabSel = insuranceType === '保険外' ? S.tabOutside : S.tabInsurance;
  try { const tab = await waitForElement(tabSel, { timeout: 4000 }); await humanSleep(); safeClick(tab); await humanSleep(); } catch (_) {}
  const addBtn = await waitForElement(S.addServiceButton);
  await humanSleep(); safeClick(addBtn); await humanSleep();
}
async function handleFillService(profile, service = {}) {
  const P = profile.sel.popup;
  await waitForElement(P.root); await humanSleep();
  await setRadio(service.insuranceType === '保険外' ? P.insuranceOutside : P.insuranceInside);
  await selectOption(P.serviceType, service.serviceType);
  await selectOption(P.serviceOffice, service.serviceOffice);
  await fillInput(P.serviceContent, service.serviceContent);
  await fillInput(P.units, service.units);
  const st = splitTime(service.startTime), et = splitTime(service.endTime);
  if (st) { await selectOption(P.startHour, st.h); await selectOption(P.startMin, st.m); }
  if (et) { await selectOption(P.endHour, et.h); await selectOption(P.endMin, et.m); }
  await setRadio((service.provisionCycle === '第N' || service.provisionNthWeek) ? P.cycleNth : P.cycleWeekly);
  for (const d of (service.provisionDays || [])) await setCheckbox(P.weekday(d), true);
  const saveBtn = await waitForElement(P.saveButton);
  await humanSleep(); safeClick(saveBtn); await humanSleep();
}
async function handleFillSupport(profile, index, supportDetails = []) {
  const S = profile.sel;
  if (!supportDetails.length) return;
  const tab = await waitForElement(buildSelector(S.supportTab, { index })); await humanSleep(); safeClick(tab); await humanSleep();
  const content = await waitForElement(buildSelector(S.supportTabContent, { index })); await humanSleep();
  for (let r = 0; r < supportDetails.length; r++) {
    let rows = content.querySelectorAll(S.supportRows);
    if (r >= rows.length) {
      const addBtn = content.querySelector(S.addSupportRow);
      if (!addBtn) throw new Error(`援助内容の行が不足（必要 ${supportDetails.length}/現在 ${rows.length}）。行追加ボタンなし。`);
      await humanSleep(); safeClick(addBtn); await humanSleep();
      rows = content.querySelectorAll(S.supportRows);
    }
    const row = rows[r], d = supportDetails[r];
    if (d.category) await selectOption(S.rowCategory, d.category, { root: row });
    if (d.item) await selectOption(S.rowItem, d.item, { root: row });
    if (d.content) await fillInput(S.rowContent, d.content, { root: row });
    if (d.requiredTime) await fillInput(S.rowTime, d.requiredTime, { root: row });
    if (d.notes) await fillInput(S.rowNotes, d.notes, { root: row });
    await humanSleep();
  }
}
async function handleFillFooter(profile, basicInfo = {}) {
  const S = profile.sel;
  await setWarekiDate(S.deliveryDate, basicInfo.explainDate);
  await fillInput(S.explainer, basicInfo.explainer);
}
function splitTime(t) { const m = t && String(t).match(/^(\d{1,2}):(\d{2})$/); return m ? { h: m[1], m: m[2] } : null; }

// =============================================================
// 役割判定・初期化・メッセージ受信
// =============================================================
const PROFILE = detectProfile();

// 別ウィンドウ型（要介護/要支援）のサービスポップアップは background に準備完了を通知
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
        case 'RUN_ALL': { // 障害（inline）: 全処理をここで完結
          const result = await runShogai(PROFILE, message.payload);
          sendResponse({ ok: true, message: `サービス ${result.count} 件の下書き入力が完了しました。` });
          return;
        }
        // 以下は 要介護/要支援（window）用の個別コマンド
        case 'FILL_BASIC': await handleFillBasic(PROFILE, message.basicInfo); break;
        case 'OPEN_SERVICE_MODAL': await handleOpenServiceModal(PROFILE, message.insuranceType); break;
        case 'FILL_SERVICE': await handleFillService(PROFILE, message.service); break;
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
  return true; // 非同期応答
});

// FILL_SERVICE は別ウィンドウ側の content.js が受ける（PROFILE.isServicePopup のとき）。
// その場合 message.service を受けてフォーム入力する。
if (PROFILE && PROFILE.isServicePopup) {
  chrome.runtime.onMessage.addListener((message, _s, sendResponse) => {
    if (!message || message.cmd !== 'FILL_SERVICE') return;
    (async () => {
      try { await handleFillService(PROFILE, message.service); sendResponse({ ok: true }); }
      catch (err) { sendResponse({ ok: false, message: err && err.message ? err.message : String(err) }); }
    })();
    return true;
  });
}
