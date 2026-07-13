// content.js（v2：実画面対応）
// カイポケ「訪問介護計画書 新規追加」＋「サービス設定」ポップアップの自動入力コアロジック。
//
// 【重要・コンプライアンス】（詳細は claude.md）
//   - 内部APIへの直接通信（fetch/XHR等）は一切行わない。純粋なDOM操作のみ。
//   - すべてのアクション間に humanSleep()（500〜1500ms のランダム待機）を挟む。
//   - waitForElement は必ずタイムアウト（既定10秒）を持ち、失敗時は安全停止しユーザーに通知する。
//   - セレクタはロジックにハードコードせず、下記 SELECTORS に集約する。
//
// 【構成】このスクリプトはカイポケ全ページに注入され、URLで「役割」を判定して振る舞う。
//   - メイン画面（訪問介護計画書 新規追加）: 基本情報／援助目標／サービス追加ボタン／援助内容タブ／説明欄
//   - サービス設定ポップアップ（.../plan_document/MEM093104.do）: サービス設定フォーム
//   親子ウィンドウの順序制御は background.js が担当する。
//
// ※実際のDOM（id/class）は環境・カイポケのバージョンで異なります。SELECTORS は
//   保守担当（システム部）が DevTools で実画面に合わせて調整する前提のプレースホルダです。

// =============================================================
// SELECTORS — セレクタ集約（ハードコード禁止：変更はここだけで完結させる）
// =============================================================
const SELECTORS = {
  // --- URL 判定（役割の切り替えに使用） ---
  url: {
    servicePopup: 'plan_document/MEM',   // サービス設定ポップアップURLの部分一致（MEM093104.do 等）
  },

  // --- ① 基本情報（メイン画面 上部）。日付は和暦の 元号/年/月/日 select ---
  basicInfo: {
    createdDate: { era: '#createdDate-era', year: '#createdDate-year', month: '#createdDate-month', day: '#createdDate-day' },
    insurancePeriod: '#insurance-period',   // 被保険証適用期間（select）
    author: '#plan-author',                 // 計画作成者氏名（text）
    careOffice: '#care-office',             // 居宅介護支援事業所（select）
    careManager: '#care-manager',           // 担当ケアマネージャー（select）
  },

  // --- ② 援助目標（メイン画面 中部） ---
  goals: {
    issues: '#goal-issues',                 // 解決すべき課題（textarea）
    longTerm: '#goal-long-term',            // 長期目標（textarea）
    shortTerm: '#goal-short-term',          // 短期目標（textarea）
    personFamilyHope: '#goal-hope',         // 本人・家族の希望（textarea）
    notes: '#goal-notes',                   // 留意点（textarea）
  },

  // --- ③ サービスの保険区分タブ＆「新規追加する」ボタン（メイン画面） ---
  serviceArea: {
    tabInsurance: '#tab-hokennai',          // 「保険内」タブ
    tabOutside: '#tab-hokengai',            // 「保険外」タブ
    addButton: '#btn-add-service',          // 「新規追加する」ボタン（ポップアップを開く）
  },

  // --- ④ サービス設定ポップアップ（別ウィンドウ MEM093104.do） ---
  popup: {
    root: '#service-form',                  // フォームのルート（出現待機の対象）
    insuranceInside: 'input[name="hokenKubun"][value="1"]',  // 保険区分＝保険内（radio）
    insuranceOutside: 'input[name="hokenKubun"][value="2"]', // 保険区分＝保険外（radio）
    serviceType: '#service-type',           // サービス種類（select）
    serviceOffice: '#service-office',       // サービス事業所（select）
    serviceContent: '#service-content',     // サービス内容（textarea）
    units: '#service-units',                // 単位数（text）
    startHour: '#start-hour', startMin: '#start-min',        // 開始 時/分（select）
    endHour: '#end-hour', endMin: '#end-min',                // 終了 時/分（select）
    // 提供日：毎週/第N のラジオと曜日チェックボックス
    cycleWeekly: 'input[name="teikyoCycle"][value="weekly"]',
    cycleNth: 'input[name="teikyoCycle"][value="nth"]',
    weekday: (d) => `input[name="youbi"][value="${d}"]`,     // 曜日チェック（値は 月/火/…）
    saveButton: '#btn-service-save',        // 「保存する」ボタン
  },

  // --- ⑤ 援助内容（メイン画面：サービスタブと繰り返し行） ---
  support: {
    tab: '#service-tab-{index}',                    // サービスN タブ（{index}は0始まり）
    tabContent: '#service-tab-content-{index}',     // タブの中身（root）
    rows: '.support-row',                           // 援助内容の行（root配下）
    addRowButton: '.support-add-row',               // 行追加ボタン（不足時に使用）
    // 各行内のフィールド（行要素を起点に相対探索）
    rowCategory: '.support-category',               // サービス項目カテゴリ（身体/生活 select）
    rowItem: '.support-item',                       // サービス項目（select）
    rowContent: '.support-content',                 // 具体的内容（textarea）
    rowTime: '.support-time',                       // 所要時間（分・text）
    rowNotes: '.support-notes',                     // 留意事項（textarea）
  },

  // --- ⑥ 説明欄（メイン画面 下部）。作成状態・登録ボタンは自動化では触らない ---
  footer: {
    explainDate: { era: '#explainDate-era', year: '#explainDate-year', month: '#explainDate-month', day: '#explainDate-day' },
    explainer: '#explainer',                // 説明者（text）
  },
};

// {index} 等のプレースホルダをセレクタに埋め込む
function buildSelector(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key]));
}

// =============================================================
// コアスキル（skills.md 準拠）
// =============================================================
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 500〜1500ms のランダム待機（人間の操作揺らぎを模倣）。全アクション間に必ず挟む。 */
function humanSleep() { return sleep(500 + Math.floor(Math.random() * 1001)); }

/** 要素の出現待機。必ずタイムアウト（既定10秒）を持ち、超過時は例外で安全停止。 */
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

/** ネイティブの value セッターで値を設定し input/change を強制発火。 */
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

/** 安全なクリック。null/disabled は例外で安全停止。可視化してから押下。 */
function safeClick(element) {
  if (!element) throw new Error('safeClick: クリック対象が null です。処理を停止します。');
  if (element.disabled) throw new Error('safeClick: クリック対象が disabled 状態です。処理を停止します。');
  element.scrollIntoView({ block: 'center', inline: 'center' });
  if (typeof element.focus === 'function') element.focus();
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  element.click();
}

// =============================================================
// 入力ヘルパー（待機→スリープ→入力→スリープ を一貫化）
// =============================================================

/** テキスト/テキストエリア入力（未指定はスキップ）。 */
async function fillInput(selector, value, options = {}) {
  if (value === undefined || value === null || value === '') return;
  const el = await waitForElement(selector, options);
  await humanSleep();
  setNativeValue(el, String(value));
  await humanSleep();
}

/** select で表示テキストまたは value 一致の項目を選択（見つからなければ安全停止）。 */
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
    // 部分一致も試す（前後空白・全角括弧などの揺れ対策）
    for (const opt of Array.from(el.options || [])) {
      if (opt.textContent.trim().includes(target)) { matched = opt; break; }
    }
  }
  if (!matched) {
    throw new Error(`選択肢が見つかりません: "${selector}" に「${target}」が存在しません（カイポケ登録値と一致していない可能性）。`);
  }
  setNativeValue(el, matched.value);
  await humanSleep();
}

/** ラジオボタンを選択。 */
async function setRadio(selector, options = {}) {
  const el = await waitForElement(selector, options);
  await humanSleep();
  el.checked = true;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  safeClick(el);
  await humanSleep();
}

/** チェックボックスを希望状態にする。 */
async function setCheckbox(selector, checked, options = {}) {
  const el = await waitForElement(selector, options);
  if (el.checked !== !!checked) {
    await humanSleep();
    safeClick(el);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  await humanSleep();
}

/** 和暦日付文字列（例「令和8年7月13日」）を 元号/年/月/日 の select 群に設定。 */
async function setWarekiDate(dateSelectors, warekiStr, options = {}) {
  if (!warekiStr) return;
  const parsed = parseWareki(warekiStr);
  if (!parsed) throw new Error(`和暦日付の解釈に失敗しました: "${warekiStr}"（例: 令和8年7月13日）`);
  await selectOption(dateSelectors.era, parsed.era, options);
  await selectOption(dateSelectors.year, parsed.year, options);
  await selectOption(dateSelectors.month, parsed.month, options);
  await selectOption(dateSelectors.day, parsed.day, options);
}

/** 「令和8年7月13日」→ {era:'令和', year:'8', month:'7', day:'13'} */
function parseWareki(s) {
  const m = String(s).match(/^\s*(明治|大正|昭和|平成|令和)\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日\s*$/);
  if (!m) return null;
  return { era: m[1], year: m[2], month: m[3], day: m[4] };
}

// =============================================================
// メイン画面：各コマンドの処理
// =============================================================

/** ① 基本情報＋援助目標の入力 */
async function handleFillBasic(basicInfo = {}) {
  const B = SELECTORS.basicInfo;
  await setWarekiDate(B.createdDate, basicInfo.createdDate);
  await selectOption(B.insurancePeriod, basicInfo.insurancePeriod);
  await fillInput(B.author, basicInfo.author);
  await selectOption(B.careOffice, basicInfo.careOffice);
  await selectOption(B.careManager, basicInfo.careManager);

  const G = SELECTORS.goals;
  await fillInput(G.issues, basicInfo.issues);
  await fillInput(G.longTerm, basicInfo.longTermGoal);
  await fillInput(G.shortTerm, basicInfo.shortTermGoal);
  await fillInput(G.personFamilyHope, basicInfo.personFamilyHope);
  await fillInput(G.notes, basicInfo.notes);
}

/** ②a 保険区分タブを選び「新規追加する」を押してポップアップを開く */
async function handleOpenServiceModal(insuranceType) {
  const A = SELECTORS.serviceArea;
  // 保険内/保険外タブの選択
  const tabSel = insuranceType === '保険外' ? A.tabOutside : A.tabInsurance;
  try {
    const tab = await waitForElement(tabSel, { timeout: 4000 });
    await humanSleep();
    safeClick(tab);
    await humanSleep();
  } catch (_) { /* タブが常時表示なら失敗しても続行 */ }

  const addBtn = await waitForElement(A.addButton);
  await humanSleep();
  safeClick(addBtn); // ここで別ウィンドウ（ポップアップ）が開く
  await humanSleep();
}

/** ②c 援助内容タブ（サービスindex）の繰り返し行を入力 */
async function handleFillSupport(index, supportDetails = []) {
  if (!supportDetails.length) return;

  // タブの出現待機 → クリックして開く
  const tab = await waitForElement(buildSelector(SELECTORS.support.tab, { index }));
  await humanSleep();
  safeClick(tab);
  await humanSleep();

  const content = await waitForElement(buildSelector(SELECTORS.support.tabContent, { index }));
  await humanSleep();

  // 既存行を取得し、不足分は行追加ボタンで確保
  for (let r = 0; r < supportDetails.length; r++) {
    let rows = content.querySelectorAll(SELECTORS.support.rows);
    if (r >= rows.length) {
      const addBtn = content.querySelector(SELECTORS.support.addRowButton);
      if (!addBtn) {
        throw new Error(`援助内容の行が不足しています（必要 ${supportDetails.length} / 現在 ${rows.length}）。行追加ボタンが見つかりません。`);
      }
      await humanSleep();
      safeClick(addBtn);
      await humanSleep();
      rows = content.querySelectorAll(SELECTORS.support.rows);
    }

    const row = rows[r];
    const d = supportDetails[r];
    const S = SELECTORS.support;

    // カテゴリ→項目の順に選択（項目はカテゴリに連動するため順序重要）
    if (d.category) await selectOption(S.rowCategory, d.category, { root: row });
    if (d.item) await selectOption(S.rowItem, d.item, { root: row });
    if (d.content) await fillInput(S.rowContent, d.content, { root: row });
    if (d.requiredTime) await fillInput(S.rowTime, d.requiredTime, { root: row });
    if (d.notes) await fillInput(S.rowNotes, d.notes, { root: row });
    await humanSleep();
  }
}

/** ③ 説明日・説明者（作成状態・登録ボタンは触らない） */
async function handleFillFooter(basicInfo = {}) {
  const F = SELECTORS.footer;
  await setWarekiDate(F.explainDate, basicInfo.explainDate);
  await fillInput(F.explainer, basicInfo.explainer);
}

// =============================================================
// ポップアップ（サービス設定）：フォーム入力
// =============================================================
async function handleFillService(service = {}) {
  const P = SELECTORS.popup;
  await waitForElement(P.root); // フォーム出現待機
  await humanSleep();

  // 保険区分
  await setRadio(service.insuranceType === '保険外' ? P.insuranceOutside : P.insuranceInside);
  // 種類・事業所・内容・単位数
  await selectOption(P.serviceType, service.serviceType);
  await selectOption(P.serviceOffice, service.serviceOffice);
  await fillInput(P.serviceContent, service.serviceContent);
  await fillInput(P.units, service.units);

  // 開始・終了時間（"08:00" → 時 "08" / 分 "00"）
  const st = splitTime(service.startTime);
  const et = splitTime(service.endTime);
  if (st) { await selectOption(P.startHour, st.h); await selectOption(P.startMin, st.m); }
  if (et) { await selectOption(P.endHour, et.h); await selectOption(P.endMin, et.m); }

  // 提供サイクル（毎週/第N）＋曜日
  if (service.provisionCycle === '第N' || service.provisionNthWeek) {
    await setRadio(P.cycleNth);
  } else {
    await setRadio(P.cycleWeekly);
  }
  const days = Array.isArray(service.provisionDays) ? service.provisionDays : [];
  for (const d of days) {
    await setCheckbox(P.weekday(d), true);
  }

  // 保存（このあとウィンドウは閉じる想定。background が閉鎖を待つ）
  const saveBtn = await waitForElement(P.saveButton);
  await humanSleep();
  safeClick(saveBtn);
  await humanSleep();
}

/** "08:00" → {h:'08', m:'00'} */
function splitTime(t) {
  if (!t) return null;
  const m = String(t).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return { h: m[1], m: m[2] };
}

// =============================================================
// 役割判定と初期化
// =============================================================
const IS_SERVICE_POPUP = location.href.includes(SELECTORS.url.servicePopup);

// ポップアップページなら、読み込み完了を background に通知（順序制御のため）
if (IS_SERVICE_POPUP) {
  // background 側が待受を用意してからボタンが押される流れだが、取りこぼし防止に少し待って通知
  const announce = () => chrome.runtime.sendMessage({ type: 'POPUP_READY' }, () => void chrome.runtime.lastError);
  if (document.readyState === 'complete') announce();
  else window.addEventListener('load', announce);
}

// =============================================================
// background.js からのコマンド受信
// =============================================================
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.cmd) return;

  (async () => {
    try {
      switch (message.cmd) {
        case 'FILL_BASIC': await handleFillBasic(message.basicInfo); break;
        case 'OPEN_SERVICE_MODAL': await handleOpenServiceModal(message.insuranceType); break;
        case 'FILL_SERVICE': await handleFillService(message.service); break;
        case 'FILL_SUPPORT': await handleFillSupport(message.index, message.supportDetails); break;
        case 'FILL_FOOTER': await handleFillFooter(message.basicInfo); break;
        default: throw new Error('未知のコマンド: ' + message.cmd);
      }
      sendResponse({ ok: true });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      // 【暴走防止】停止をユーザーに明示
      alert(
        'カイポケ自動入力を安全に停止しました。\n\n理由：' + msg +
        '\n\n画面のレイアウトが変わった可能性があります。\nシステム部にセレクタ（SELECTORS）の確認を依頼してください。'
      );
      sendResponse({ ok: false, message: msg });
    }
  })();

  return true; // 非同期応答
});
