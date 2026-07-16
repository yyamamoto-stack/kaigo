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
// 実績の備考へ サ責確認コメントを一括追記（v2.20.0 直近2日・作業日翌日スタンプ方式）
// 対象画面：月間シフト割当一覧（従業員別）。
// 業務内容：従業員が作業日に入力した備考コメントに対し、担当サ責が「見ました」の記録を残す。
//   例）7/16の作業コメント →「【サ責】石原裕子2026/07/17　10:18」を既存コメントの手前に追記
//   ・対象行＝今日と昨日の作業分のみ（それ以外の日付・コメント未入力の行には触らない）
//   ・サ責名＝利用者売上表（03レセプト・経理部）のAS列「担当者」に基づく対応表から利用者ごとに決定
//     （対応表は下のテキスト欄で編集でき、chrome.storageに保存される。担当変更時はここを直す）
//   ・日付＝その行の作業日の翌日
//   ・時刻＝10:00〜10:30 のランダム。同じ日付には同じ時刻を使う（storageに日付→時刻を保存し、
//     従業員を切り替えて何回実行しても・再実行しても同じ時刻になる）
// 書き込み自体は content.js（JISSEKI_SCAN／JISSEKI_FILL）が行う。
// =============================================================
const jissekiStatusEl = document.getElementById("jissekiStatus");
function setJissekiStatus(message, kind = "info") {
  jissekiStatusEl.textContent = message;
  jissekiStatusEl.className = "status-" + kind;
}

// 結果の構造化表示：結論（headline）と対象箇所（strongLines）は黒太字で目立たせ、
// 件数内訳や手順などの補足（detailLines）は小さくグレーで出す。
// ページ由来のテキスト（利用者名・コメント）を含むため innerHTML は使わず DOM を組み立てる。
function renderJissekiResult({ headline, strongLines = [], warnLines = [], detailLines = [] }) {
  jissekiStatusEl.className = "";
  jissekiStatusEl.innerHTML = "";
  const head = document.createElement("div");
  head.className = "jisseki-head";
  head.textContent = headline;
  jissekiStatusEl.appendChild(head);
  if (strongLines.length) {
    const strong = document.createElement("div");
    strong.className = "jisseki-strong";
    strongLines.forEach((t) => {
      const line = document.createElement("div");
      line.textContent = t;
      strong.appendChild(line);
    });
    jissekiStatusEl.appendChild(strong);
  }
  if (warnLines.length) {
    const warn = document.createElement("div");
    warn.className = "jisseki-warn";
    warnLines.forEach((t) => {
      const line = document.createElement("div");
      line.textContent = "⚠️ " + t;
      warn.appendChild(line);
    });
    jissekiStatusEl.appendChild(warn);
  }
  if (detailLines.length) {
    const detail = document.createElement("div");
    detail.className = "jisseki-detail";
    detailLines.forEach((t) => {
      const line = document.createElement("div");
      line.textContent = t;
      detail.appendChild(line);
    });
    jissekiStatusEl.appendChild(detail);
  }
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

// 対象の作業日の設定欄（日付ピッカー×2）。既定＝①今日・②昨日。
// パネルを開くたびに既定へ戻す（前日の設定が残って誤った日に入れる事故を防ぐ）。
// ②を空にすれば1日分だけ、日付を変えれば過去の作業分の消化にも使える。
const jissekiDate1El = document.getElementById("jissekiDate1");
const jissekiDate2El = document.getElementById("jissekiDate2");
function jissekiDateInputValue(d) {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}
{
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  jissekiDate1El.value = jissekiDateInputValue(today);
  jissekiDate2El.value = jissekiDateInputValue(yesterday);
}

// 設定欄から対象の作業日リストを読む（空欄は無視・重複は除去）
function jissekiSelectedWorkDates() {
  const dates = [];
  const seen = new Set();
  [jissekiDate1El.value, jissekiDate2El.value].forEach((v) => {
    if (!v || seen.has(v)) return;
    const d = new Date(v + "T00:00:00");
    if (isNaN(d.getTime())) return;
    seen.add(v);
    dates.push(d);
  });
  return dates;
}

// 対象日と、それぞれのスタンプ（作業日の翌日＋日付ごとの固定ランダム時刻）を組み立てる
async function jissekiBuildStamp() {
  const workDates = jissekiSelectedWorkDates();
  if (!workDates.length) throw new Error("対象の作業日が設定されていません。日付欄①を入力してください。");
  const data = await chrome.storage.local.get("kaipokeJissekiTimes");
  const times = (data && data.kaipokeJissekiTimes) || {};
  let changed = false;
  const mkTarget = (workDate) => {
    const stamp = new Date(workDate.getTime());
    stamp.setDate(stamp.getDate() + 1); // スタンプ日付＝作業日の翌日
    const dateKey = stamp.getFullYear() + "-" + pad2(stamp.getMonth() + 1) + "-" + pad2(stamp.getDate());
    let time = times[dateKey];
    if (!time) {
      time = "10:" + pad2(Math.floor(Math.random() * 31)); // 10:00〜10:30
      times[dateKey] = time;
      changed = true;
    }
    return {
      ym: String(workDate.getFullYear()) + pad2(workDate.getMonth() + 1), // 作業日の年月（表示中の月の確認用）
      day: workDate.getDate(),                                            // 作業日の「日」（一覧の日付列と照合）
      workLabel: (workDate.getMonth() + 1) + "/" + workDate.getDate(),
      dateStr: stamp.getFullYear() + "/" + pad2(stamp.getMonth() + 1) + "/" + pad2(stamp.getDate()),
      time,
    };
  };
  const targets = workDates.map(mkTarget);
  if (changed) {
    // 60日より古い日付の記録は掃除してから保存
    const limit = Date.now() - 60 * 24 * 60 * 60 * 1000;
    for (const k of Object.keys(times)) {
      if (new Date(k + "T00:00:00").getTime() < limit) delete times[k];
    }
    await chrome.storage.local.set({ kaipokeJissekiTimes: times });
  }
  const mapping = jissekiParseTantou(jissekiTantouEl.value);
  return { targets, mapping };
}

// 追記コメントのプレビューを表示（時刻もこの時点で確定・保存される）。日付欄の変更で更新
async function jissekiRenderPreview() {
  try {
    const s = await jissekiBuildStamp();
    const lines = s.targets.map((t) =>
      `${t.workLabel}の実績 → 【サ責】（担当サ責名）${t.dateStr}　${t.time}`).join("\n");
    document.getElementById("jissekiPreview").textContent = lines;
  } catch (e) {
    document.getElementById("jissekiPreview").textContent = "コメントの準備に失敗：" + e.message;
  }
}
jissekiRenderPreview();
jissekiDate1El.addEventListener("change", jissekiRenderPreview);
jissekiDate2El.addEventListener("change", jissekiRenderPreview);

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

// 集計結果（counts）の共通表示文（補足用の小さい文字で出す）
function jissekiCountLine(r) {
  const c = r.counts || {};
  return `内訳：追記対象 ${c.fill || 0}／追記済み ${c.already || 0}／コメント未入力 ${c.empty || 0}／対象日以外 ${c.otherday || 0}` +
    ((c.warn || 0) ? `／特定不能 ${c.warn}` : "");
}

// ① 備考欄を確認（読み取りのみ。何も書き込まない）
document.getElementById("jissekiScanBtn").addEventListener("click", async () => {
  setJissekiStatus("備考欄を探しています…", "info");
  try {
    const s = await jissekiBuildStamp();
    const r = await jissekiSend("JISSEKI_SCAN", { mapping: s.mapping, targets: s.targets });
    if (r.screen === "helperMonthly" && !r.popupOpen) {
      if (r.hasActualBtn) {
        renderJissekiResult({
          headline: "画面OK。②を押すと備考ポップアップを開いて確認・追記します",
          detailLines: [
            (r.title || "") + (r.pager ? "　" + r.pager : ""),
            "先に計画だけ見たい場合は、実績側の「備考」ボタンを押してから もう一度①を押してください。",
          ],
        });
      } else {
        setJissekiStatus("月間シフト割当一覧のようですが、実績側の「備考」ボタンが見つかりません。画面を再読み込み（F5）してから再実行してください。", "error");
      }
      return;
    }
    if (!r.total) {
      setJissekiStatus("この画面に「備考」の入力欄が見つかりませんでした。\n月間シフト割当一覧（従業員別の実績画面）を開いてから実行してください。\nそれでも見つからない場合は、画面を Ctrl+S でHTML保存してシステム部に解析を依頼してください。", "error");
      return;
    }
    const c = r.counts || {};
    if (c.fill) {
      renderJissekiResult({
        headline: `✍ 書き込みあり：${c.fill}件 →「② コメントを追記」を押してください`,
        strongLines: (r.fillList || []),
        warnLines: r.warnings || [],
        detailLines: [jissekiCountLine(r), r.pager || ""].filter(Boolean),
      });
    } else {
      renderJissekiResult({
        headline: "✔ 書き込みなし（このページに追記する行はありません）",
        warnLines: r.warnings || [],
        detailLines: [
          "対象日のコメント入力済み行が無いか、すべて追記済みです。",
          jissekiCountLine(r),
          r.pager || "",
        ].filter(Boolean),
      });
    }
  } catch (e) {
    setJissekiStatus("確認できませんでした：" + e.message, "error");
  }
});

// ② コメントを追記（対象＝設定した作業日の分でコメント入力済みの行のみ）
document.getElementById("jissekiFillBtn").addEventListener("click", async () => {
  try {
    const s = await jissekiBuildStamp();
    if (!s.mapping.length) {
      setJissekiStatus("利用者→担当サ責の対応表が空です。下の対応表欄を入力してください。", "error");
      return;
    }
    setJissekiStatus("追記しています…（1欄ごとに0.5〜1.5秒の間隔をあけて入力します）", "info");
    const r = await jissekiSend("JISSEKI_FILL", { mapping: s.mapping, targets: s.targets });
    const c = r.counts || {};
    if (c.fill) {
      renderJissekiResult({
        headline: `✅ ${c.fill}件 追記しました → 目視確認して「登録する」を押してください`,
        warnLines: r.warnings || [],
        detailLines: [
          jissekiCountLine(r),
          r.pager || "",
          "対象日が別ページにある場合は、ページを送って もう一度②を実行。",
          "終わったら次の従業員に切り替えて同じ手順を（同じ日は同じ時刻が入ります）。",
        ].filter(Boolean),
      });
    } else {
      renderJissekiResult({
        headline: "✔ 書き込みなし（このページに追記した行はありません）",
        warnLines: r.warnings || [],
        detailLines: [
          "ポップアップはキャンセルで閉じて構いません。",
          jissekiCountLine(r),
          r.pager || "",
          "対象日が別ページにある場合は、ページを送って もう一度②を実行してください。",
        ].filter(Boolean),
      });
    }
  } catch (e) {
    setJissekiStatus("停止しました：" + e.message, "error");
  }
});
