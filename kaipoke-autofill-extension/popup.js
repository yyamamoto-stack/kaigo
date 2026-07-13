// popup.js
// 役割：テキストエリアの JSON をパース・検証し、background.js（調整役）へ開始を依頼する。
// このファイルは DOM 操作もカイポケ通信も行わない。

// -------------------------------------------------------------
// サンプルJSON（実画面「訪問介護計画書 新規追加」に対応した構造）
// 実データは「サービス提供責任者（サ責）」がAIで作成する（README参照）。
// ※ select 項目（適用期間・事業所・ケアマネ・サービス種類・サービス項目）は
//   カイポケに登録済みの選択肢と「完全一致」する文字列にすること。
// -------------------------------------------------------------
const SAMPLE_JSON = {
  basicInfo: {
    createdDate: "令和8年7月13日",
    insurancePeriod: "令和8年2月2日から令和9年2月28日まで",
    author: "山本 禎典",
    careOffice: "向日葵 介護センター",
    careManager: "矢部 房子",
    issues: "自宅で安全に生活を継続すること。",
    longTermGoal: "住み慣れた自宅で自立した生活を送れる。",
    shortTermGoal: "入浴・清潔保持を安全に行える。",
    personFamilyHope: "できる限り自宅で過ごしたい。",
    notes: "母国語が話せるヘルパーを派遣いたします。",
    explainDate: "令和8年4月8日",
    explainer: "麻生 操子"
  },
  services: [
    {
      insuranceType: "保険内",
      serviceType: "身体生活",
      serviceOffice: "訪問介護 いっぽ(2371005485)",
      serviceContent: "入浴介助・生活援助",
      units: "75",
      startTime: "08:00",
      endTime: "09:15",
      additions: [],
      provisionCycle: "毎週",
      provisionNthWeek: null,
      provisionDays: ["月", "水", "金"],
      supportDetails: [
        { category: "身体", item: "全身浴",   content: "入浴介助または清拭", requiredTime: "20", notes: "" },
        { category: "身体", item: "更衣介助", content: "洗面等、着替え、歯磨き", requiredTime: "10", notes: "" },
        { category: "生活", item: "掃除",     content: "居室、トイレ、浴室、台所などの掃除", requiredTime: "80", notes: "" }
      ]
    }
  ]
};

const statusEl = document.getElementById("status");
function setStatus(message, kind = "info") {
  statusEl.textContent = message;
  statusEl.className = "status-" + kind;
}

// -------------------------------------------------------------
// 入力JSONの簡易バリデーション
// -------------------------------------------------------------
function validatePayload(data) {
  if (typeof data !== "object" || data === null) throw new Error("JSONのトップレベルはオブジェクトである必要があります。");
  if (typeof data.basicInfo !== "object" || data.basicInfo === null) throw new Error('"basicInfo"（基本情報オブジェクト）がありません。');
  if (!Array.isArray(data.services)) throw new Error('"services"（サービスの配列）がありません。');
  if (data.services.length === 0) throw new Error('"services" が空です。少なくとも1件のサービスを含めてください。');
  data.services.forEach((s, i) => {
    if (s.supportDetails && !Array.isArray(s.supportDetails)) {
      throw new Error(`services[${i}].supportDetails は配列である必要があります。`);
    }
  });
}

// 「サンプルを挿入」
document.getElementById("sampleBtn").addEventListener("click", () => {
  document.getElementById("jsonInput").value = JSON.stringify(SAMPLE_JSON, null, 2);
  setStatus("サンプルを挿入しました。内容を編集して実行してください。", "info");
});

// 「自動入力を実行」
document.getElementById("runBtn").addEventListener("click", async () => {
  const raw = document.getElementById("jsonInput").value.trim();
  if (!raw) { setStatus("JSONを貼り付けてください。", "error"); return; }

  let payload;
  try {
    payload = JSON.parse(raw);
    validatePayload(payload);
  } catch (e) {
    setStatus("JSONエラー：" + e.message, "error");
    return;
  }

  // アクティブタブ（＝メイン画面）の取得
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    setStatus("アクティブタブの取得に失敗しました：" + e.message, "error");
    return;
  }
  if (!tab || !tab.id) { setStatus("対象のタブが見つかりません。", "error"); return; }
  if (!tab.url || !/^https:\/\/[^/]*kaipoke\.biz\//.test(tab.url)) {
    setStatus("カイポケ（kaipoke.biz）の計画書画面を開いた状態で実行してください。", "error");
    return;
  }

  // ★ポップアップブロックの注意（サービス設定は別ウィンドウで開く）
  setStatus("自動入力を開始しました。\n※サービス設定は別ウィンドウで開きます。ポップアップがブロックされないよう許可してください。\nカイポケ画面の進捗をご確認ください…", "info");

  // background.js（調整役）へ開始依頼。メインタブID を渡す。
  try {
    const response = await chrome.runtime.sendMessage({
      type: "START_AUTOFILL",
      tabId: tab.id,
      payload,
    });
    if (response && response.ok) {
      setStatus("完了しました：" + (response.message || "自動入力が終了しました。") +
        "\n※必ず目視確認のうえ、作成状態を「作成済」にしてから、ご自身で「登録する」を押してください。", "ok");
    } else {
      setStatus("停止しました：" + ((response && response.message) || "不明なエラー"), "error");
    }
  } catch (e) {
    setStatus("拡張機能と通信できませんでした。カイポケの計画書画面で拡張機能を再読み込みしてください。\n詳細：" + e.message, "error");
  }
});
