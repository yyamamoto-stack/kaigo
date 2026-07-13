// content.js
// カイポケ「訪問介護計画書 新規追加」画面に対する自動入力のコアロジック。
//
// 【重要・コンプライアンス】（詳細は claude.md）
//   - 内部APIへの直接通信（fetch/XHR等）は一切行わない。純粋なDOM操作のみ。
//   - すべてのアクション間に humanSleep()（500〜1500ms のランダム待機）を挟む。
//   - waitForElement は必ずタイムアウト（既定10秒）を持ち、失敗時は安全停止しユーザーに通知する。
//   - セレクタはロジックにハードコードせず、下記 SELECTORS に集約する。
//
// ※カイポケの実際のDOM構造は環境・バージョンにより異なります。
//   下記 SELECTORS は「保守担当（システム管理者）」が実画面に合わせて調整する前提の
//   プレースホルダです（README「保守」参照）。

// =============================================================
// SELECTORS — セレクタ集約（ハードコード禁止：変更はここだけで完結させる）
// =============================================================
const SELECTORS = {
  // --- ① 基本情報エリア ---
  basicInfo: {
    createdDate:     '#plan-created-date',        // 作成年月日
    author:          '#plan-author',              // 計画作成者
    planPeriodFrom:  '#plan-period-from',         // 計画期間（開始）
    planPeriodTo:    '#plan-period-to',           // 計画期間（終了）
    goal:            '#plan-goal',                // 援助目標（textarea想定）
  },

  // --- ② サービス「新規追加」ボタン ---
  addServiceButton: '#btn-add-service',

  // --- ③ サービス追加モーダル ---
  modal: {
    root:        '#service-modal',                // モーダルのルート要素（出現待機の対象）
    serviceType: '#service-type',                 // サービス種別（select想定）
    dayOfWeek:   '#service-day',                  // 曜日（select想定）
    startTime:   '#service-start-time',           // 開始時刻
    endTime:     '#service-end-time',             // 終了時刻
    saveButton:  '#service-modal-save',           // モーダルの保存ボタン
  },

  // --- ⑥ 保存後にメイン画面へ動的生成されるサービスタブ ---
  // {index} は 0 始まりのサービス番号に置換して使う（buildSelector参照）。
  serviceTab:        '#service-tab-{index}',       // 生成されたタブ（クリック対象／出現待機対象）
  serviceTabContent: '#service-tab-content-{index}', // タブの中身（コンテンツ領域）

  // --- ⑦ タブ内：援助内容の入力欄 ---
  // タブコンテンツ領域(root)を起点に相対探索する想定。
  supportContent:    '.support-content-input',     // 援助内容（textarea想定）
};

// {index} 等のプレースホルダをセレクタに埋め込むヘルパー
function buildSelector(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key]));
}

// =============================================================
// コアスキル（skills.md の実装をそのまま利用）
// =============================================================

/** 指定ミリ秒だけ待機する */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 500〜1500ms のランダム待機（人間の操作揺らぎを模倣）。
 * 【安全規約】すべてのアクション間に必ず挟む。
 */
function humanSleep() {
  const ms = 500 + Math.floor(Math.random() * 1001); // 500〜1500
  return sleep(ms);
}

/**
 * 要素の出現待機。必ずタイムアウト（既定10秒）を持ち、超過時は例外で安全停止させる。
 * @param {string} selector CSSセレクタ
 * @param {object} [options] {timeout, interval, root, visible}
 * @returns {Promise<Element>}
 */
function waitForElement(selector, options = {}) {
  const {
    timeout = 10000,   // 【暴走防止】既定10秒でタイムアウト
    interval = 200,
    root = document,
    visible = true,
  } = options;

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const isVisible = (el) => {
      if (!visible) return true;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const tick = () => {
      const el = root.querySelector(selector);
      if (el && isVisible(el)) {
        resolve(el);
        return;
      }
      if (Date.now() - startedAt >= timeout) {
        reject(new Error(`要素が見つかりませんでした（タイムアウト ${timeout}ms）: "${selector}"`));
        return;
      }
      setTimeout(tick, interval);
    };

    tick();
  });
}

/**
 * ネイティブの value セッターで値を設定し、input/change を強制発火する。
 * （React等の制御コンポーネントでも確実に反映させるため）
 */
function setNativeValue(element, value) {
  if (!element) {
    throw new Error('setNativeValue: 対象要素が null です。');
  }
  const prototype = Object.getPrototypeOf(element);
  const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
  const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

  if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
    prototypeValueSetter.call(element, value);
  } else if (valueSetter) {
    valueSetter.call(element, value);
  } else {
    element.value = value;
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * 安全なクリック。null/disabled は例外で安全停止。可視化してから押下する。
 */
function safeClick(element) {
  if (!element) {
    throw new Error('safeClick: クリック対象が null です。処理を停止します。');
  }
  if (element.disabled) {
    throw new Error('safeClick: クリック対象が disabled 状態です。処理を停止します。');
  }
  element.scrollIntoView({ block: 'center', inline: 'center' });
  if (typeof element.focus === 'function') element.focus();
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  element.click();
}

// =============================================================
// 入力ヘルパー（待機→スリープ→入力→スリープ を一貫化）
// =============================================================

/**
 * テキスト/テキストエリアへ値を入力する（待機・スリープ・ネイティブ発火つき）。
 * value が undefined/null/'' の場合はスキップする（未指定項目を壊さない）。
 * @param {string} selector
 * @param {*} value
 * @param {object} [options] waitForElement へ渡すオプション（root等）
 */
async function fillInput(selector, value, options = {}) {
  if (value === undefined || value === null || value === '') return;
  const el = await waitForElement(selector, options); // 出現待機（タイムアウトあり）
  await humanSleep();                                  // 人間らしい待機
  setNativeValue(el, String(value));                  // ネイティブイベント発火で入力
  await humanSleep();                                  // 次の操作まで待機
}

/**
 * select 要素で、指定の表示テキストまたは value に一致する項目を選択する。
 */
async function selectOption(selector, value, options = {}) {
  if (value === undefined || value === null || value === '') return;
  const el = await waitForElement(selector, options);
  await humanSleep();

  const target = String(value);
  let matched = null;
  for (const opt of Array.from(el.options || [])) {
    if (opt.value === target || opt.textContent.trim() === target) {
      matched = opt;
      break;
    }
  }
  if (!matched) {
    // 一致する選択肢が無い場合は安全停止（誤入力を避ける）
    throw new Error(`選択肢が見つかりません: セレクタ "${selector}" に "${target}" が存在しません。`);
  }
  setNativeValue(el, matched.value);
  await humanSleep();
}

// =============================================================
// 処理フロー本体
// =============================================================

/**
 * ① 基本情報の入力
 */
async function fillBasicInfo(basicInfo) {
  const S = SELECTORS.basicInfo;
  await fillInput(S.createdDate, basicInfo.createdDate);
  await fillInput(S.author, basicInfo.author);
  await fillInput(S.planPeriodFrom, basicInfo.planPeriodFrom);
  await fillInput(S.planPeriodTo, basicInfo.planPeriodTo);
  await fillInput(S.goal, basicInfo.goal);
}

/**
 * ②〜⑤ サービス1件を「新規追加」ボタン→モーダル入力→保存 で登録する。
 * （援助内容は保存後に生成されるタブへ入力するため、ここでは扱わない）
 */
async function addServiceViaModal(service) {
  // ② 「新規追加」ボタン押下
  const addBtn = await waitForElement(SELECTORS.addServiceButton);
  await humanSleep();
  safeClick(addBtn);
  await humanSleep();

  // ③ モーダルの出現待機
  const modalRoot = await waitForElement(SELECTORS.modal.root);
  await humanSleep();

  // ④ モーダル内へサービス情報を入力（各入力間に humanSleep が入る）
  const M = SELECTORS.modal;
  // モーダル内探索を確実にするため root を渡す
  await selectOption(M.serviceType, service.serviceType, { root: modalRoot });
  await selectOption(M.dayOfWeek, service.dayOfWeek, { root: modalRoot });
  await fillInput(M.startTime, service.startTime, { root: modalRoot });
  await fillInput(M.endTime, service.endTime, { root: modalRoot });

  // ⑤ モーダルの保存ボタン押下
  const saveBtn = await waitForElement(M.saveButton, { root: modalRoot });
  await humanSleep();
  safeClick(saveBtn);
  await humanSleep();

  // モーダルが閉じるのを待つ（消えるまで最大10秒）。閉じない場合は安全停止。
  await waitForElementToDisappear(M.root);
  await humanSleep();
}

/**
 * ⑥⑦ 保存後にメイン画面へ動的生成されたサービスタブを開き、援助内容を入力する。
 * @param {number} index 0始まりのサービス番号
 * @param {object} service
 */
async function fillServiceTab(index, service) {
  // ⑥ 動的タブ生成の待機
  const tabSelector = buildSelector(SELECTORS.serviceTab, { index });
  const tab = await waitForElement(tabSelector);
  await humanSleep();

  // タブをクリックして開く
  safeClick(tab);
  await humanSleep();

  // タブコンテンツの出現待機
  const contentSelector = buildSelector(SELECTORS.serviceTabContent, { index });
  const content = await waitForElement(contentSelector);
  await humanSleep();

  // ⑦ タブ内の援助内容入力欄へ入力（content を起点に相対探索）
  await fillInput(SELECTORS.supportContent, service.supportContent, { root: content });
}

/**
 * 要素が DOM から消える／非表示になるまで待機する（モーダルクローズ確認用）。
 */
function waitForElementToDisappear(selector, options = {}) {
  const { timeout = 10000, interval = 200, root = document } = options;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      const el = root.querySelector(selector);
      const gone =
        !el ||
        window.getComputedStyle(el).display === 'none' ||
        window.getComputedStyle(el).visibility === 'hidden';
      if (gone) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeout) {
        reject(new Error(`要素が消えませんでした（タイムアウト ${timeout}ms）: "${selector}"`));
        return;
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

/**
 * 自動入力のメインフロー。
 * @param {{basicInfo: object, services: object[]}} payload
 */
async function runAutofill(payload) {
  const { basicInfo, services } = payload;

  // ① 基本情報の入力
  await fillBasicInfo(basicInfo);
  await humanSleep();

  // サービスごとに ②〜⑤（モーダル登録）を実行
  for (let i = 0; i < services.length; i++) {
    await addServiceViaModal(services[i]);
    await humanSleep(); // 各サービスの間にも必ず待機（連続リクエスト回避）
  }

  // 全モーダル登録後、⑥⑦（タブへの援助内容入力）を実行
  for (let i = 0; i < services.length; i++) {
    await fillServiceTab(i, services[i]);
    await humanSleep();
  }
}

// =============================================================
// popup.js からのメッセージ受信 → 実行
// =============================================================
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'KAIPOKE_AUTOFILL') {
    return; // 対象外メッセージは無視
  }

  // 非同期処理の結果を返すため true を返す（sendResponse を後で呼ぶ）
  (async () => {
    try {
      await runAutofill(message.payload);
      sendResponse({
        ok: true,
        message: `基本情報と ${message.payload.services.length} 件のサービスの下書き入力が完了しました。`,
      });
    } catch (err) {
      // 【暴走防止】どこかで停止した場合はユーザーに明示してから結果を返す
      const msg = err && err.message ? err.message : String(err);
      // 画面上でも即座に気づけるようアラートを出す
      alert(
        'カイポケ自動入力を安全に停止しました。\n\n' +
        '理由：' + msg + '\n\n' +
        '画面のレイアウトが変わった可能性があります。\n' +
        'システム管理者にセレクタ（SELECTORS）の確認を依頼してください。'
      );
      sendResponse({ ok: false, message: msg });
    }
  })();

  return true; // 非同期応答を有効化
});
