// background.js（Service Worker / MV3）
// 役割：メイン画面と「サービス設定」ポップアップ別ウィンドウをまたぐ自動入力の【調整役】。
//
// なぜ必要か：
//   カイポケの計画書画面では、サービス追加ボタンを押すと別ウィンドウ（ポップアップ、
//   URL: .../plan_document/MEM093104.do）が開く。content.js はページごと（ウィンドウごと）に
//   別インスタンスで動くため、親（メイン）と子（ポップアップ）を直接またいで操作できない。
//   そこで両者の間に立ち、状態機械（ステートマシン）として処理順序を制御する。
//
// 【コンプライアンス】ここでは fetch 等の外部通信は一切行わない（メッセージ中継と待機のみ）。
//   実際のDOM操作・スリープは各 content.js が担当する。

// -------------------------------------------------------------
// ユーティリティ：特定タブへメッセージを送り、応答（完了）を待つ
// content.js 側は処理完了時に {ok:true} を返す約束。
// -------------------------------------------------------------
function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response && response.ok) {
        resolve(response);
      } else {
        reject(new Error((response && response.message) || 'content.js から失敗応答'));
      }
    });
  });
}

// -------------------------------------------------------------
// ポップアップ（サービス設定ウィンドウ）の準備完了を待つ仕組み。
// 子ウィンドウの content.js は読み込み時に POPUP_READY を送ってくる。
// -------------------------------------------------------------
let pendingPopupResolver = null; // ポップアップ待ち中の resolve 関数

function waitForPopupReady(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPopupResolver = null;
      reject(new Error('サービス設定ポップアップが時間内に開きませんでした（ポップアップブロックの可能性）。'));
    }, timeoutMs);

    // POPUP_READY 受信時に呼ばれる
    pendingPopupResolver = (popupTabId) => {
      clearTimeout(timer);
      pendingPopupResolver = null;
      resolve(popupTabId);
    };
  });
}

// -------------------------------------------------------------
// 指定タブ（ポップアップ）が閉じるのを待つ。
// -------------------------------------------------------------
function waitForTabRemoved(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onRemoved.removeListener(onRemoved);
      // 閉じない場合でも致命ではないため、resolve して次へ進めるが警告は残す
      resolve(false);
    }, timeoutMs);

    const onRemoved = (removedId) => {
      if (removedId === tabId) {
        clearTimeout(timer);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        resolve(true);
      }
    };
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

// -------------------------------------------------------------
// メインのオーケストレーション（処理全体の順序制御）
//   ① 基本情報＋援助目標の入力（メイン）
//   ② 各サービスについて：
//        a. メインで「新規追加する」を押しポップアップを開く
//        b. ポップアップでサービス設定を入力・保存（ウィンドウが閉じる）
//        c. メインの該当サービスタブに援助内容（複数行）を入力
//   ③ 説明日・説明者の入力（メイン）※作成状態は「作成中」のまま／登録は人間
// -------------------------------------------------------------
async function orchestrate(payload, mainTabId) {
  const services = Array.isArray(payload.services) ? payload.services : [];

  // ① 基本情報＋援助目標
  await sendToTab(mainTabId, { cmd: 'FILL_BASIC', basicInfo: payload.basicInfo });

  // ② サービスごと
  for (let i = 0; i < services.length; i++) {
    const service = services[i];

    // a. ポップアップ待受を先に用意 → メインでサービス追加ボタン押下
    const popupReady = waitForPopupReady();
    await sendToTab(mainTabId, {
      cmd: 'OPEN_SERVICE_MODAL',
      insuranceType: service.insuranceType || '保険内',
      index: i,
    });

    // b. ポップアップが開いたら、その content.js にサービス情報を入力させる
    const popupTabId = await popupReady;
    await sendToTab(popupTabId, { cmd: 'FILL_SERVICE', service });

    // ポップアップが閉じるのを待つ（保存後に自動で閉じる想定）
    await waitForTabRemoved(popupTabId);

    // c. メイン画面：動的生成されたサービスタブに援助内容を入力
    await sendToTab(mainTabId, {
      cmd: 'FILL_SUPPORT',
      index: i,
      supportDetails: service.supportDetails || [],
    });
  }

  // ③ 説明日・説明者（作成状態は触らない）
  await sendToTab(mainTabId, { cmd: 'FILL_FOOTER', basicInfo: payload.basicInfo });

  return { count: services.length };
}

// -------------------------------------------------------------
// メッセージ受信ハンドラ
//   - START_AUTOFILL : popup.js からの開始指示（メインタブIDとpayloadを含む）
//   - POPUP_READY    : ポップアップ側 content.js の準備完了通知
// -------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  // ポップアップ（サービス設定ウィンドウ）が「準備できた」と知らせてきた
  if (message.type === 'POPUP_READY') {
    const popupTabId = sender.tab && sender.tab.id;
    if (pendingPopupResolver && popupTabId) {
      pendingPopupResolver(popupTabId);
      sendResponse({ ok: true });
    } else {
      // 想定外のタイミング（自動入力中でない）。何もしない。
      sendResponse({ ok: true, ignored: true });
    }
    return true;
  }

  // popup.js からの自動入力開始
  if (message.type === 'START_AUTOFILL') {
    const mainTabId = message.tabId;
    orchestrate(message.payload, mainTabId)
      .then((result) => sendResponse({ ok: true, message: `サービス ${result.count} 件の下書き入力が完了しました。` }))
      .catch((err) => sendResponse({ ok: false, message: err && err.message ? err.message : String(err) }));
    return true; // 非同期応答
  }
});
