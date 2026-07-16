// popup.js
// 役割：テキストエリアの JSON をパース・検証し、background.js（調整役）へ開始を依頼する。
// このファイルは DOM 操作もカイポケ通信も行わない。

// -------------------------------------------------------------
// JSONデータは管理者ポータルの「訪問介護計画書 原案作成（AI下書き）」画面で作成し、
// 「JSONをコピー」でここに貼り付ける運用（スキーマの詳細は README 参照）。
// ※ select 項目（適用期間・事業所・ケアマネ・サービス種類・サービス項目）は
//   カイポケに登録済みの選択肢と「完全一致」する文字列にすること。
// -------------------------------------------------------------

const statusEl = document.getElementById("status");
function setStatus(message, kind = "info") {
  statusEl.textContent = message;
  statusEl.className = "status-" + kind;
}

// -------------------------------------------------------------
// 進捗表示：background からの PROGRESS 通知でバーとラベルを更新
// -------------------------------------------------------------
function setProgress(percent, label) {
  const wrap = document.getElementById("progressWrap");
  const bar = document.getElementById("progressBar");
  const labelEl = document.getElementById("progressLabel");
  wrap.style.display = "block";
  const pct = Math.max(0, Math.min(100, Math.round(percent || 0)));
  bar.style.width = pct + "%";
  labelEl.textContent = pct + "%　" + (label || "");
}

// -------------------------------------------------------------
// 工程リスト（プラン）の表示：✓済み（取り消し線）／▶実行中／✗エラー／⚠要手動
// content.js がDOMの実態から導出した工程配列を background 経由で受け取って描画する。
// -------------------------------------------------------------
function renderSteps(steps) {
  const wrap = document.getElementById("stepsWrap");
  const list = document.getElementById("planSteps");
  if (!Array.isArray(steps) || !steps.length) return; // 空の通知では前回表示を消さない
  wrap.style.display = "block";
  list.innerHTML = "";
  const MARK = { done: "✓ ", run: "▶ ", error: "✗ ", warn: "⚠ " };
  for (const s of steps) {
    const li = document.createElement("li");
    const state = s.state || "todo";
    li.className = "step-" + state;
    li.textContent = (MARK[state] || "・") + (s.label || "");
    list.appendChild(li);
  }
}

// 実行ボタンを押した直後、backgroundの初回応答を待たずにJSONから全工程を「予定」として表示する
function renderPreviewSteps(payload) {
  const services = Array.isArray(payload.services) ? payload.services : [];
  const isIdou = (s) => String(s.serviceType || "").indexOf("移動支援") >= 0 || s.insuranceType === "保険外";
  const steps = [{ id: "basic", label: "基本情報・援助目標・契約支給量", state: "todo" }];
  services.forEach((s, i) => {
    if (isIdou(s)) return;
    const n = i + 1;
    steps.push({ id: "svc" + n, label: `サービス${n} 設定登録（保険内 ${s.startTime || ""}〜${s.endTime || ""} ${(s.provisionDays || []).join("")}）`, state: "todo" });
    if ((s.supportDetails || []).length) {
      steps.push({ id: "sup" + n, label: `サービス${n} 援助内容の入力（${s.supportDetails.length}行）`, state: "todo" });
    } else {
      steps.push({ id: "sup" + n, label: `サービス${n} 援助内容：明細なし（手動入力）`, state: "warn" });
    }
  });
  services.forEach((s, i) => {
    if (!isIdou(s)) return;
    const n = i + 1;
    steps.push({ id: "svc" + n, label: `サービス${n} 設定登録（移動支援・保険外 ${s.startTime || ""}〜${s.endTime || ""} ${(s.provisionDays || []).join("")}）`, state: "todo" });
  });
  if (String((payload.basicInfo || {}).remarks || "").trim()) {
    steps.push({ id: "remarks", label: "【計画予定表】タブ：備考の入力", state: "todo" });
  }
  steps.push({ id: "footer", label: "説明日の入力（仕上げ）", state: "todo" });
  renderSteps(steps);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "PROGRESS") {
    setProgress(msg.percent, msg.label);
    renderSteps(msg.steps);
  }
});

// ポップアップを開き直したとき、実行中なら現在の進捗と工程リストをすぐ復元表示する
// （工程の合間は通知が来ないため、これが無いと開き直し直後にバーが出ない）
chrome.storage.local.get("kaipokeProgress", (d) => {
  var p = d && d.kaipokeProgress;
  if (p && Date.now() - (p.ts || 0) < 60 * 60 * 1000) {
    if (typeof p.percent === "number" && p.percent < 100) setProgress(p.percent, p.label + "（実行中）");
    renderSteps(p.steps); // 工程リストは停止中（人が登録する待ち）でも見えたほうが分かりやすい
  }
});

// -------------------------------------------------------------
// JSONの自動保存・復元
// ポップアップは「登録する」等でフォーカスが外れると閉じてしまうため、
// テキストエリアの内容を常に chrome.storage.local へ保存し、次に開いたとき復元する。
// （2段階運用＝登録→編集画面で同じJSONを再実行、がこれでシームレスになる）
// -------------------------------------------------------------
const jsonInputEl = document.getElementById("jsonInput");
function saveJsonDraft() {
  try { chrome.storage.local.set({ kaipokeJsonDraft: jsonInputEl.value }); } catch (_) {}
}
chrome.storage.local.get("kaipokeJsonDraft", (data) => {
  const saved = data && data.kaipokeJsonDraft;
  if (typeof saved === "string" && saved.trim() && !jsonInputEl.value) {
    jsonInputEl.value = saved;
    setStatus("前回のJSONを復元しました。そのまま「自動入力を実行」で再開できます。", "info");
  }
});
jsonInputEl.addEventListener("input", saveJsonDraft);

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

// 「JSONをクリア」
// テキストエリアと自動保存済みの下書き（kaipokeJsonDraft）を両方消す。
// 消し忘れた前回分が次の利用者に復元される事故を防ぐためのボタン。
document.getElementById("clearBtn").addEventListener("click", () => {
  if (jsonInputEl.value.trim() && !confirm("入力中のJSONデータを消去します。よろしいですか？")) return;
  jsonInputEl.value = "";
  try { chrome.storage.local.remove(["kaipokeJsonDraft", "kaipokeProgress"]); } catch (_) {}
  document.getElementById("progressWrap").style.display = "none";
  document.getElementById("stepsWrap").style.display = "none";
  document.getElementById("planSteps").innerHTML = "";
  setStatus("JSONデータをクリアしました。原案作成アプリで作成したJSONを貼り付けてください。", "info");
});

// 「自動入力を実行」
document.getElementById("runBtn").addEventListener("click", async () => {
  const raw = document.getElementById("jsonInput").value.trim();
  if (!raw) { setStatus("JSONを貼り付けてください。", "error"); return; }
  saveJsonDraft(); // 実行時点の内容を確実に保存（登録ボタン等でポップアップが閉じても復元できるように）

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
  setStatus("自動入力を開始しました。\n※サービス設定は別ウィンドウで開きます。ポップアップがブロックされないよう許可してください。", "info");
  setProgress(0, "開始しています…");
  renderPreviewSteps(payload); // 実行前に全工程のプランを表示（実態はcontent.jsからの通知で上書きされる）

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
