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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "PROGRESS") setProgress(msg.percent, msg.label);
});

// ポップアップを開き直したとき、実行中なら現在の進捗をすぐ復元表示する
// （工程の合間は通知が来ないため、これが無いと開き直し直後にバーが出ない）
chrome.storage.local.get("kaipokeProgress", (d) => {
  var p = d && d.kaipokeProgress;
  if (p && typeof p.percent === "number" && p.percent < 100 && Date.now() - (p.ts || 0) < 10 * 60 * 1000) {
    setProgress(p.percent, p.label + "（実行中）");
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
  setStatus("JSONデータをクリアしました。原案作成アプリで作成したJSONを貼り付けてください。", "info");
});

// 「診断ログをコピー」（v2.9.7）
// backgroundが記録した計画書画面へのPOST内容（直近10件）をクリップボードへコピーする。
// 移動支援（保険外）の保存不具合調査用：手動登録の成功POSTと自動入力のPOSTを比較する。
document.getElementById("diagBtn").addEventListener("click", () => {
  chrome.storage.local.get({ kaipokePostLog: [] }, async (st) => {
    const log = Array.isArray(st.kaipokePostLog) ? st.kaipokePostLog : [];
    if (!log.length) {
      setStatus("診断ログはまだありません。カイポケの計画書画面で保存操作（手動または自動入力）を行うと記録されます。", "info");
      return;
    }
    const text = JSON.stringify(log, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`診断ログ（POST記録 ${log.length}件）をコピーしました。そのままチャットに貼り付けてシステム部（Claude）に渡してください。`, "ok");
    } catch (e) {
      setStatus("クリップボードへのコピーに失敗しました：" + e.message, "error");
    }
  });
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
