// popup.js
// 役割：テキストエリアの JSON をパース・検証し、content.js へ送信する。
// このファイルは DOM 操作もカイポケ通信も行わない（送信の中継のみ）。

// -------------------------------------------------------------
// サンプルJSON（貼り付け欄の初期例・フォーマット確認用）
// 実データは「サービス提供責任者・管理者」がAIで作成する（README参照）。
// -------------------------------------------------------------
const SAMPLE_JSON = {
  basicInfo: {
    // 基本情報エリアに入力する項目（キーは content.js の SELECTORS と対応）
    createdDate: "2026-07-13",      // 作成年月日
    author: "山本 太郎",            // 計画作成者
    planPeriodFrom: "2026-08-01",   // 計画期間（開始）
    planPeriodTo: "2027-01-31",     // 計画期間（終了）
    goal: "自宅で安全に生活を継続できる。"  // 援助目標
  },
  services: [
    // ポップアップ（モーダル）で1件ずつ追加していくサービスの配列
    {
      serviceType: "身体介護",       // サービス種別
      dayOfWeek: "月",               // 曜日
      startTime: "10:00",           // 開始時刻
      endTime: "11:00",             // 終了時刻
      // メイン画面に生成されるタブへ入力する援助内容
      supportContent: "入浴介助、着替えの見守り。"
    },
    {
      serviceType: "生活援助",
      dayOfWeek: "木",
      startTime: "14:00",
      endTime: "15:00",
      supportContent: "掃除、買い物代行。"
    }
  ]
};

// ステータス表示ヘルパー
const statusEl = document.getElementById("status");
function setStatus(message, kind = "info") {
  statusEl.textContent = message;
  statusEl.className = "status-" + kind; // status-info / status-ok / status-error
}

// -------------------------------------------------------------
// 入力JSONの簡易バリデーション
// basicInfo（オブジェクト）と services（配列）を持つ階層構造を必須とする。
// -------------------------------------------------------------
function validatePayload(data) {
  if (typeof data !== "object" || data === null) {
    throw new Error("JSONのトップレベルはオブジェクトである必要があります。");
  }
  if (typeof data.basicInfo !== "object" || data.basicInfo === null) {
    throw new Error('"basicInfo"（基本情報オブジェクト）がありません。');
  }
  if (!Array.isArray(data.services)) {
    throw new Error('"services"（サービスの配列）がありません。');
  }
  if (data.services.length === 0) {
    throw new Error('"services" が空です。少なくとも1件のサービスを含めてください。');
  }
}

// -------------------------------------------------------------
// 「サンプルを挿入」ボタン
// -------------------------------------------------------------
document.getElementById("sampleBtn").addEventListener("click", () => {
  document.getElementById("jsonInput").value = JSON.stringify(SAMPLE_JSON, null, 2);
  setStatus("サンプルを挿入しました。内容を編集して実行してください。", "info");
});

// -------------------------------------------------------------
// 「自動入力を実行」ボタン
// 1) JSONをパース＆検証
// 2) アクティブなカイポケタブを取得
// 3) content.js にメッセージ送信
// -------------------------------------------------------------
document.getElementById("runBtn").addEventListener("click", async () => {
  const raw = document.getElementById("jsonInput").value.trim();

  // 1) 入力チェック＆パース
  if (!raw) {
    setStatus("JSONを貼り付けてください。", "error");
    return;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
    validatePayload(payload);
  } catch (e) {
    setStatus("JSONエラー：" + e.message, "error");
    return;
  }

  // 2) アクティブタブの取得（activeTab 権限）
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    setStatus("アクティブタブの取得に失敗しました：" + e.message, "error");
    return;
  }
  if (!tab || !tab.id) {
    setStatus("対象のタブが見つかりません。", "error");
    return;
  }

  // 対象がカイポケのページか簡易確認（誤操作防止）
  if (!tab.url || !/^https:\/\/[^/]*kaipoke\.biz\//.test(tab.url)) {
    setStatus("カイポケ（kaipoke.biz）の計画書画面を開いた状態で実行してください。", "error");
    return;
  }

  // 3) content.js へメッセージ送信
  setStatus("自動入力を開始しました。カイポケ画面の進捗をご確認ください…", "info");
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "KAIPOKE_AUTOFILL",
      payload,
    });

    // content.js からの結果を表示
    if (response && response.ok) {
      setStatus("完了しました：" + (response.message || "自動入力が終了しました。") +
        "\n※必ず目視確認のうえ、ご自身で登録してください。", "ok");
    } else {
      setStatus("停止しました：" + ((response && response.message) || "不明なエラー"), "error");
    }
  } catch (e) {
    // content.js が注入されていない等
    setStatus(
      "content.js と通信できませんでした。カイポケの計画書画面で拡張機能を再読み込みしてください。\n詳細：" + e.message,
      "error"
    );
  }
});
