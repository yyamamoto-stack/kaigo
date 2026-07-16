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
  renderSteps(steps);
}

// -------------------------------------------------------------
// 結果メッセージの表示：完了（緑）／一時停止＝人が「登録する」して再実行（青）／エラー（赤）
// ポップアップは画面クリックで閉じてしまい実行完了時に開いていないことが多いため、
// backgroundが保存した結果（kaipokeLastResult）を開き直したときに必ず表示する。
// -------------------------------------------------------------
function showResult(ok, paused, msg) {
  if (!ok) {
    setStatus("停止しました：" + (msg || "不明なエラー"), "error");
  } else if (paused) {
    setStatus("一時停止中（続きがあります）：" + (msg || ""), "pause");
  } else {
    setStatus("完了しました：" + (msg || "自動入力が終了しました。") +
      "\n※必ず目視確認のうえ、作成状態を「作成済」にしてから、ご自身で「登録する」を押してください。", "ok");
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "PROGRESS") {
    setProgress(msg.percent, msg.label);
    renderSteps(msg.steps);
  }
  if (msg && msg.type === "RESULT") {
    showResult(msg.ok, msg.paused, msg.message);
  }
});

// ポップアップを開き直したとき、進捗・工程リスト・前回の結果メッセージをすぐ復元表示する
// （工程の合間は通知が来ないため、これが無いと開き直し直後に何も見えない）
chrome.storage.local.get(["kaipokeProgress", "kaipokeLastResult"], (d) => {
  var p = d && d.kaipokeProgress;
  if (p && Date.now() - (p.ts || 0) < 60 * 60 * 1000) {
    if (typeof p.percent === "number" && p.percent < 100) setProgress(p.percent, p.label);
    renderSteps(p.steps); // 工程リストは停止中（人が登録する待ち）でも見えたほうが分かりやすい
  }
  var r = d && d.kaipokeLastResult;
  if (r && Date.now() - (r.ts || 0) < 60 * 60 * 1000) {
    showResult(r.ok, r.paused, r.message);
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
// 対象タブ（＝カイポケの画面）の取得（計画書・実績備考の両機能で共通）
// サイドパネル/別ウィンドウのどちらから実行されても動くよう、全ウィンドウのアクティブタブから
// カイポケ（kaipoke.biz）のタブを探す（URLはhost_permissionsの範囲内のみ見える）。
// 複数ウィンドウでカイポケを開いている場合は、最後に触ったタブを対象にする。
// -------------------------------------------------------------
async function findKaipokeTab() {
  const tabs = await chrome.tabs.query({ active: true });
  const kaipokeTabs = tabs.filter((t) => t.id && /^https:\/\/[^/]*kaipoke\.biz\//.test(t.url || ""));
  kaipokeTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return kaipokeTabs[0];
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

// 「JSONをクリア」
// テキストエリアと自動保存済みの下書き（kaipokeJsonDraft）を両方消す。
// 消し忘れた前回分が次の利用者に復元される事故を防ぐためのボタン。
document.getElementById("clearBtn").addEventListener("click", () => {
  if (jsonInputEl.value.trim() && !confirm("入力中のJSONデータを消去します。よろしいですか？")) return;
  jsonInputEl.value = "";
  try { chrome.storage.local.remove(["kaipokeJsonDraft", "kaipokeProgress", "kaipokeLastResult"]); } catch (_) {}
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

  // 対象タブ（＝カイポケのメイン画面）の取得。
  let tab;
  try {
    tab = await findKaipokeTab();
  } catch (e) {
    setStatus("アクティブタブの取得に失敗しました：" + e.message, "error");
    return;
  }
  if (!tab || !tab.id) {
    setStatus("カイポケ（kaipoke.biz）の計画書画面を開いた状態で実行してください。", "error");
    return;
  }

  // ★ポップアップブロックの注意（サービス設定は別ウィンドウで開く）
  setStatus("自動入力を開始しました。\n※サービス設定は別ウィンドウで開きます。ポップアップがブロックされないよう許可してください。", "info");
  setProgress(0, "開始しています…");
  try { chrome.storage.local.remove("kaipokeLastResult"); } catch (_) {} // 前回の結果表示は新しい実行でリセット
  // 工程リストがまだ空のとき（初回実行）だけ、JSONから全工程のプランを予定表示する。
  // 2回目以降は前回までの済み（取り消し線）を残し、content.jsからの実態通知で上書きされるのを待つ。
  if (document.getElementById("planSteps").children.length === 0) {
    renderPreviewSteps(payload);
  }

  // background.js（調整役）へ開始依頼。メインタブID を渡す。
  try {
    const response = await chrome.runtime.sendMessage({
      type: "START_AUTOFILL",
      tabId: tab.id,
      payload,
    });
    if (response) {
      showResult(!!response.ok, !!response.paused, response.message);
    }
  } catch (e) {
    setStatus("拡張機能と通信できませんでした。カイポケの計画書画面で拡張機能を再読み込みしてください。\n詳細：" + e.message, "error");
  }
});

// =============================================================
// 実績の備考へ サ責確認コメントを一括追記（v2.19.0 担当サ責対応）
// 対象画面：月間シフト割当一覧（従業員別）。既存コメントの手前に3行形式で追記する。
// コメント形式（サ責名は行の利用者の担当サービス提供責任者。既存コメントと同じ社内慣行の表記）：
//   【サ責】石原裕子
//   2026/07/17
//   10:07
//   ・サ責名＝利用者売上表（03レセプト・経理部）のAS列「担当者」に基づく対応表から利用者ごとに決定
//     （対応表は下のテキスト欄で編集でき、chrome.storageに保存される。担当変更時はここを直す）
//   ・日付＝実行日の翌日
//   ・時刻＝10:00〜10:30 のランダム。同じ日付には同じ時刻を使う（storageに日付→時刻を保存し、
//     従業員を切り替えて何回実行しても・再実行しても同じ時刻になる）
// 書き込み自体は content.js（JISSEKI_SCAN／JISSEKI_FILL）が行う。
// =============================================================
const jissekiStatusEl = document.getElementById("jissekiStatus");
function setJissekiStatus(message, kind = "info") {
  jissekiStatusEl.textContent = message;
  jissekiStatusEl.className = "status-" + kind;
}
const pad2 = (n) => String(n).padStart(2, "0");

// 利用者→担当サ責の対応表は、個人情報（利用者名簿）のためコードには埋め込まない。
// Driveの「20260716_利用者担当サ責対応表.txt」（08システム部\管理者向けアプリ開発担当）の内容を
// サイドパネルの対応表欄へ一度貼り付けると、chrome.storage（この PC 内）にのみ保存される。
// 元データは利用者売上表（03レセプト・経理部）のAS列「担当者」。担当変更時は欄を直接編集する。
const JISSEKI_TANTOU_DEFAULT = "";

// 対応表テキスト→[[利用者名, サ責名], ...]（区切りは ：: ＝ = , 、 タブ のどれでも可）
function jissekiParseTantou(text) {
  const pairs = [];
  String(text || "").split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("//")) return;
    const m = t.split(/[：:＝=,、\t]+/).map((s) => s.trim()).filter(Boolean);
    if (m.length >= 2) pairs.push([m[0], m[1]]);
  });
  return pairs;
}

// 対応表テキストエリアの保存・復元（既定値は上の対応表）
const jissekiTantouEl = document.getElementById("jissekiTantou");
chrome.storage.local.get("kaipokeJissekiTantou", (d) => {
  const saved = d && d.kaipokeJissekiTantou;
  jissekiTantouEl.value = (typeof saved === "string" && saved.trim()) ? saved : JISSEKI_TANTOU_DEFAULT;
});
jissekiTantouEl.addEventListener("input", () => {
  try { chrome.storage.local.set({ kaipokeJissekiTantou: jissekiTantouEl.value }); } catch (_) {}
});

// 追記する日付・時刻を決める（翌日の日付＋日付ごとに固定のランダム時刻）
async function jissekiBuildStamp() {
  const d = new Date();
  d.setDate(d.getDate() + 1); // 翌日
  const dateKey = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  const dateStr = d.getFullYear() + "/" + pad2(d.getMonth() + 1) + "/" + pad2(d.getDate()); // 既存コメントと同じ 2026/07/17 形式
  const data = await chrome.storage.local.get("kaipokeJissekiTimes");
  const times = (data && data.kaipokeJissekiTimes) || {};
  let time = times[dateKey];
  if (!time) {
    time = "10:" + pad2(Math.floor(Math.random() * 31)); // 10:00〜10:30
    // 60日より古い日付の記録は掃除してから保存
    const limit = Date.now() - 60 * 24 * 60 * 60 * 1000;
    for (const k of Object.keys(times)) {
      if (new Date(k + "T00:00:00").getTime() < limit) delete times[k];
    }
    times[dateKey] = time;
    await chrome.storage.local.set({ kaipokeJissekiTimes: times });
  }
  const mapping = jissekiParseTantou(jissekiTantouEl.value);
  return { dateStr, time, mapping };
}

// パネルを開いた時点で追記コメントのプレビューを表示（時刻もこの時点で確定・保存される）
async function jissekiRenderPreview() {
  try {
    const s = await jissekiBuildStamp();
    document.getElementById("jissekiPreview").textContent =
      "追記コメント：\n【サ責】（利用者の担当サ責名）\n" + s.dateStr + "\n" + s.time +
      "\n（日付=翌日固定・同じ日は同じ時刻。サ責名は下の対応表から利用者ごとに決定）";
  } catch (e) {
    document.getElementById("jissekiPreview").textContent = "コメントの準備に失敗：" + e.message;
  }
}
jissekiRenderPreview();

// content.js へコマンドを送る（実績備考用）
async function jissekiSend(cmd, extra = {}) {
  const tab = await findKaipokeTab();
  if (!tab || !tab.id) throw new Error("カイポケ（kaipoke.biz）の実績画面を開いた状態で実行してください。");
  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { cmd, ...extra });
  } catch (e) {
    throw new Error("カイポケのページと通信できませんでした。ページを再読み込み（F5）してから再実行してください。\n詳細：" + e.message);
  }
  if (!res) throw new Error("ページから応答がありませんでした。ページを再読み込み（F5）してから再実行してください。");
  if (!res.ok) throw new Error(res.message || "不明なエラー");
  return res;
}

// ① 備考欄を確認（読み取りのみ。何も書き込まない）
document.getElementById("jissekiScanBtn").addEventListener("click", async () => {
  setJissekiStatus("備考欄を探しています…", "info");
  try {
    const s = await jissekiBuildStamp();
    const r = await jissekiSend("JISSEKI_SCAN", { mapping: s.mapping, dateStr: s.dateStr });
    if (r.screen === "helperMonthly" && !r.popupOpen) {
      if (r.hasActualBtn) {
        setJissekiStatus(
          `月間シフト割当一覧を認識しました（${r.title || ""}）。${r.pager ? "\n" + r.pager : ""}\n` +
          `備考の入力ポップアップはまだ開いていません。\n` +
          `「② コメントを追記」を押すと、実績側の「備考」ボタンを自動でクリックして開き、追記します。\n` +
          `（先に中身を確認したい場合は、実績側の「備考」ボタンを押してから もう一度①を押してください）`,
          "ok"
        );
      } else {
        setJissekiStatus("月間シフト割当一覧のようですが、実績側の「備考」ボタンが見つかりません。画面を再読み込み（F5）してから再実行してください。", "error");
      }
      return;
    }
    if (!r.total) {
      setJissekiStatus("この画面に「備考」の入力欄が見つかりませんでした。\n月間シフト割当一覧（従業員別の実績画面）を開いてから実行してください。\nそれでも見つからない場合は、画面を Ctrl+S でHTML保存してシステム部に解析を依頼してください。", "error");
      return;
    }
    const tantouLines = r.perTantou ? Object.entries(r.perTantou).map(([k, v]) => `・【サ責】${k}：${v}件`).join("\n") + "\n" : "";
    const warnLines = (r.warnings || []).length ? "⚠️ 対象外（手動入力）：\n" + r.warnings.map((w) => "　" + w).join("\n") + "\n" : "";
    const sampleLines = (r.samples || []).map((s2) => `　${s2.id}：「${s2.value}${s2.value.length >= 25 ? "…" : ""}」`).join("\n");
    setJissekiStatus(
      `備考欄 ${r.total}件（うち追記済み ${r.already}件）${r.pager ? "\n" + r.pager : ""}\n${tantouLines}${warnLines}先頭の内容（日付 利用者→担当サ責）：\n${sampleLines}\n\n問題なければ「② コメントを追記」を押してください。`,
      "ok"
    );
  } catch (e) {
    setJissekiStatus("確認できませんでした：" + e.message, "error");
  }
});

// ② コメントを追記（同じサ責・同じ日付が既に入っている欄はスキップ）
document.getElementById("jissekiFillBtn").addEventListener("click", async () => {
  try {
    const s = await jissekiBuildStamp();
    if (!s.mapping.length) {
      setJissekiStatus("利用者→担当サ責の対応表が空です。下の対応表欄を入力してください。", "error");
      return;
    }
    setJissekiStatus("追記しています…（1欄ごとに0.5〜1.5秒の間隔をあけて入力します）", "info");
    const r = await jissekiSend("JISSEKI_FILL", { mapping: s.mapping, dateStr: s.dateStr, time: s.time });
    const warnLines = (r.warnings || []).length ? "⚠️ 対象外（手動入力）：\n" + r.warnings.map((w) => "　" + w).join("\n") + "\n" : "";
    setJissekiStatus(
      `追記 ${r.done}件／スキップ（追記済み）${r.already}件（対象 ${r.total}件）\n` + warnLines +
      `⚠️ ポップアップの内容を目視確認のうえ、「登録する」はご自身で押してください。\n` +
      `${r.pager ? "ページ：" + r.pager + "\n" : ""}` +
      `複数ページある場合は、登録後に「次」でページを送って もう一度②を実行してください。\n` +
      `終わったら次の従業員の月間シフト割当一覧に切り替えて、同じ手順を繰り返してください（同じ日は同じ時刻が入ります）。`,
      "ok"
    );
  } catch (e) {
    setJissekiStatus("停止しました：" + e.message, "error");
  }
});
