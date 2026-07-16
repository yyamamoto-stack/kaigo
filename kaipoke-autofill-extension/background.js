// background.js（Service Worker / MV3）v6
// v6の修正点：
//   1. OPEN_SERVICE_MODAL 送信時の通信断エラー（ajax再描画で応答チャネルだけ切れる）を無視し、
//      ポップアップが実際に開いたかは POPUP_READY 待ちで判定する。
//   2. 保存後にポップアップが閉じなかった場合（入力エラーの可能性）は明示エラーで停止する。
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
// -------------------------------------------------------------
// 進捗通知：ポップアップUI（PROGRESS）とアイコンバッジの両方に反映する。
// ポップアップが閉じていて届かなくてもエラーにしない（バッジは常に見える）。
// -------------------------------------------------------------
// 【v2.11.0】計画書画面へのPOST内容を記録するwebRequest診断機能は撤去した。
// カイポケの通信内容の記録は「解析目的の通信傍受」に読めるため、社内遵守事項に沿って行わない。

function reportProgress(percent, label) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  try {
    chrome.runtime.sendMessage({ type: 'PROGRESS', percent: pct, label }, () => void chrome.runtime.lastError);
  } catch (_) {}
  // ポップアップが閉じられていても、開き直した瞬間に現在の進捗を復元できるよう保存しておく
  try { chrome.storage.local.set({ kaipokeProgress: { percent: pct, label: label || '', ts: Date.now() } }); } catch (_) {}
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#1976d2' });
    chrome.action.setBadgeText({ text: pct >= 100 ? '✓' : String(pct) });
  } catch (_) {}
}
function reportErrorBadge() {
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
    chrome.action.setBadgeText({ text: '!' });
  } catch (_) {}
  clearBadgeLater();
}
function clearBadgeLater(delayMs = 15000) {
  setTimeout(() => { try { chrome.action.setBadgeText({ text: '' }); } catch (_) {} }, delayMs);
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        const raw = chrome.runtime.lastError.message || '';
        // 拡張機能の更新直後、開きっぱなしのカイポケ画面には新しいcontent.jsが入っていないため
        // この英語エラーになる。原因と対処が分かる日本語に変換する。
        if (raw.includes('Receiving end does not exist') || raw.includes('Could not establish connection')) {
          reject(new Error('カイポケの画面と接続できませんでした。カイポケのページを再読み込み（F5）してから、もう一度「自動入力を実行」を押してください（拡張機能を更新した直後は、開いていた画面の再読み込みが必要です）。'));
          return;
        }
        reject(new Error(raw));
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
// 画面遷移後、タブの content.js が再注入されて応答できるようになるまで待つ
// （援助内容タブの切替はページ全体の再送信＝画面遷移になるため）
// -------------------------------------------------------------
async function waitForContentReady(tabId, timeoutMs = 20000) {
  await new Promise((r) => setTimeout(r, 2500)); // まず遷移の開始と読み込みを待つ
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { cmd: 'GET_MODE' }, (r2) => {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          resolve(r2);
        });
      });
      if (res && res.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('援助内容タブ切替後の画面読み込みを確認できませんでした。ページを再読み込みして、同じJSONのままもう一度実行してください（入力済みは自動スキップされます）。');
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
// 週間計画表の行テキストと照合して、このサービスが入力済みかを判定する
// （開始・終了時刻と提供曜日がすべて同じ行があればスキップ対象）
function serviceAlreadyEntered(existingRows, svc) {
  const st = String(svc.startTime || ''), et = String(svc.endTime || '');
  const days = svc.provisionDays || [];
  if (!st) return false;
  return existingRows.some((e) => {
    const t = String(e.text || '');
    if (t.indexOf(st) < 0) return false;
    if (et && t.indexOf(et) < 0) return false;
    return days.every((d) => t.indexOf(d) >= 0);
  });
}

// 【カイポケの仕様】サービスを1件保存するごとに、計画書本体を「登録する」で保存しないと
// 次のサービスを正しく追加できない。そのため1回の実行で処理するサービスは【1件だけ】とし、
// 人が「登録する」→編集画面で再実行、を繰り返す。再実行時は週間計画表を読んで入力済みをスキップする。
async function orchestrate(payload, mainTabId, isYoshien) {
  const services = Array.isArray(payload.services) ? payload.services : [];

  // 入力済みサービスの検出（週間計画表の行テキスト）
  let existingRows = [];
  try {
    const ex = await sendToTab(mainTabId, { cmd: 'GET_EXISTING_SERVICES' });
    existingRows = (ex && ex.services) || [];
  } catch (_) {}
  const pending = services.filter((svc) => !serviceAlreadyEntered(existingRows, svc));
  const skippedCount = services.length - pending.length;

  // 今回の実行で処理する内容：基本情報（初回のみ）＋サービス1件＋（最終回のみ）説明欄
  const isLastRun = pending.length <= 1;
  const totalSteps = 2 + (pending.length ? 3 : 0);
  let doneSteps = 0;
  const progress = (label) => reportProgress((doneSteps / totalSteps) * 100, label);

  // ① 基本情報＋援助目標（入力済みサービスがある＝2回目以降は、基本情報は登録済みなのでスキップ）
  if (skippedCount === 0) {
    progress('基本情報・援助目標を入力中…（1分ほどかかります）');
    await sendToTab(mainTabId, { cmd: 'FILL_BASIC', basicInfo: payload.basicInfo });
  }
  doneSteps++;

  // サービス追加ボタンの有無を確認（新規画面＝無い＝先に保存が必要）
  let needSaveFirst = false;
  if (pending.length) {
    const chk = await sendToTab(mainTabId, { cmd: 'HAS_ADD_BUTTON' });
    if (!chk || !chk.has) needSaveFirst = true;
  }

  // ② サービス（1回の実行につき1件だけ処理する）
  let processed = 0;
  const svcWarnings = []; // ポップアップ内で自動選択できずスキップされた項目
  if (!needSaveFirst && pending.length) {
    const service = pending[0];
    const svcNo = skippedCount + 1; // 画面上のサービス番号（1始まり）

    progress(`サービス${svcNo}: 設定画面（別ウィンドウ）を開いています…`);

    // a. ポップアップ待受を先に用意 → メインでサービス追加ボタン押下
    const popupReady = waitForPopupReady();
    // 途中で別のエラーにより await popupReady まで到達しなかった場合に
    // タイムアウトが「Uncaught (in promise)」として残らないよう、控えのハンドラを付けておく
    popupReady.catch(() => {});
    try {
      await sendToTab(mainTabId, {
        cmd: 'OPEN_SERVICE_MODAL',
        insuranceType: service.insuranceType || '保険内',
        index: skippedCount,
      });
    } catch (err) {
      // ボタン押下に伴うajax再描画等で応答チャネルだけが切れることがある。
      // 実際にポップアップが開いたかは次の POPUP_READY 待ちで判定するので、通信断エラーは無視する。
      const m = String((err && err.message) || err);
      if (!m.includes('message channel closed') && !m.includes('Receiving end does not exist')) throw err;
    }

    // b. ポップアップが開いたら、その content.js にサービス情報を入力させる
    const popupTabId = await popupReady;
    doneSteps++;
    progress(`サービス${svcNo}: サービス内容を入力・保存中…`);
    // ポップアップは要介護/要支援で共通URLのため、種別(isYoshien)と保険者判定用のbasicInfoを渡す
    const svcRes = await sendToTab(popupTabId, { cmd: 'FILL_SERVICE', service, basicInfo: payload.basicInfo, isYoshien: !!isYoshien });
    if (svcRes && svcRes.skipped && svcRes.skipped.length) {
      svcWarnings.push(...svcRes.skipped.map((s) => `サービス${svcNo}: ${s}`));
    }

    // ポップアップが閉じるのを待つ（保存後に自動で閉じ、親画面は opener.refresh() で再読込される）
    const closed = await waitForTabRemoved(popupTabId);
    if (!closed) {
      throw new Error(`サービス${svcNo}の保存後にポップアップが閉じませんでした。入力エラーの可能性があるため停止します。ポップアップ内のエラー表示を確認してください。`);
    }
    // 親画面の再読込＋content.js再注入が落ち着くのを待つ
    await new Promise((r) => setTimeout(r, 2500));
    doneSteps++;
    progress(`サービス${svcNo}: 援助内容を入力中…`);

    // c. 援助内容の「サービスN」タブを選択（タブ切替はページ全体の再送信＝画面遷移になる）
    if (service.supportDetails && service.supportDetails.length) {
      const tabRes = await sendToTab(mainTabId, { cmd: 'SELECT_SUPPORT_TAB', number: svcNo });
      if (tabRes && tabRes.navigated) {
        await waitForContentReady(mainTabId); // 画面遷移→content.js再注入を待つ
      }
      // 該当サービスの援助内容に入力（実在するlistDetailインデックスはcontent側で自動検出）
      const supRes = await sendToTab(mainTabId, {
        cmd: 'FILL_SUPPORT',
        index: skippedCount,
        supportDetails: service.supportDetails || [],
      });
      if (supRes && supRes.skipped && supRes.skipped.length) {
        svcWarnings.push(...supRes.skipped.map((s) => `サービス${svcNo}: ${s}`));
      }
    }
    doneSteps++;
    processed = 1;
  }

  // ③ 説明日・説明者（最終回＝残りサービスが無くなる回のみ。作成状態は触らない）
  // ※新規画面（needSaveFirst）には説明日の欄が無いためスキップする。
  if (!needSaveFirst && isLastRun) {
    progress('説明日・説明者を入力中…');
    await sendToTab(mainTabId, { cmd: 'FILL_FOOTER', basicInfo: payload.basicInfo });
  }
  doneSteps++;

  return {
    needSaveFirst,
    processed,
    skippedCount,
    remaining: needSaveFirst ? pending.length : pending.length - processed,
    total: services.length,
    svcWarnings,
  };
}

// -------------------------------------------------------------
// 開始：計画書の種別（モード）で分岐
//   - inline（障害）: content.js に RUN_ALL を送り、全処理をページ内で完結させる
//   - window（要介護/要支援）: 別ウィンドウのポップアップをまたいで orchestrate する
// -------------------------------------------------------------
// 選択式のため自動入力の対象外とした項目（運用ルール 2026/07/14）。完了メッセージで手入力を促す。
const MANUAL_NOTE = '\n\n【手入力のお願い】被保険者証適用期間・地域包括支援センター・居宅介護支援事業所・担当ケアマネージャー（障害は受給者証適用期間）は自動入力の対象外です。原案画面のプレビューの値を参考に、カイポケ上で選択してください。';

async function startAutofill(payload, mainTabId) {
  // メインタブに種別（モード）を問い合わせる（通信断エラーはsendToTabが日本語の案内に変換する）
  const modeInfo = await sendToTab(mainTabId, { cmd: 'GET_MODE' });
  if (!modeInfo || !modeInfo.ok) throw new Error((modeInfo && modeInfo.message) || '計画書の種別を判定できませんでした。');

  if (modeInfo.mode === 'inline') {
    // 障害: サービスを1件保存するたびにページ全体が再読み込みされるため、
    // RUN_ALL（1フェーズずつ進む）を繰り返し呼び、再読み込みをまたいで自動継続する。
    const total = (payload.services || []).length;
    const allSkipped = [];
    let guard = total * 3 + 8; // 想定外ループの安全弁（サービス1件あたり 登録＋タブ切替＋援助内容 の最大3手＋仕上げ＋余裕）
    let message = '';
    let prevRemaining = Infinity; // 「進んでいない」検知用（保存が反映されず同じサービスを繰り返すのを防ぐ）
    let prevSupportNext = 0; // 援助内容タブが前に進んでいるかの検知用
    reportProgress(5, '計画書を入力中…');
    for (;;) {
      if (--guard < 0) throw new Error('障害計画書の処理が想定回数を超えました。ページを再読み込みして、同じJSONのままもう一度実行してください（入力済みは自動スキップされます）。');
      // 保存クリック直後のページ遷移とRUN_ALLがぶつかると通信断になることがある。
      // その場合は画面の読み込みを待ってから1回だけリトライする（RUN_ALLは入力済み自動スキップなので安全）。
      let r;
      try { r = await sendToTab(mainTabId, { cmd: 'RUN_ALL', payload }); }
      catch (e) {
        const em = String((e && e.message) || '');
        if (em.indexOf('channel closed') >= 0 || em.indexOf('接続できませんでした') >= 0) {
          await waitForContentReady(mainTabId);
          r = await sendToTab(mainTabId, { cmd: 'RUN_ALL', payload });
        } else throw e;
      }
      if (r.skipped && r.skipped.length) allSkipped.push(...r.skipped);
      if (r.phase === 'popupStuck') {
        throw new Error('サービス設定のポップアップが開いたままで、保存（登録する）が完了していません。ポップアップ内のエラー表示や未入力の必須項目（サービス内容・時間・提供曜日など）を確認し、手動で「登録する」を押してから、同じJSONでもう一度実行してください（入力済みは自動スキップされます）。\n※保存せず×で閉じた場合、そのサービスは今回の自動入力の対象から外れるため、必要ならカイポケで手動追加してください。');
      }
      if (r.phase === 'needSaveFirst' || r.phase === 'needBasicSave') {
        message = '基本情報を入力しました。ここで一旦停止します（エラーではありません）。\n\n【再開のしかた】\n① 内容を確認して、ご自身で「登録する」を押して保存する\n② 保存後の編集画面で、同じJSONのままもう一度「自動入力を実行」を押す\n→ 保険内のサービスが1件ずつ自動で追加されます。\n\n※カイポケでは、基本情報を保存する前にサービスを追加しようとすると「移動しますか？」の確認が出るため、先に保存する運用にしています。';
        break;
      }
      if (r.phase === 'switchTab') {
        // 週間計画表の上部タブ切替（計画予定表など）。切替後の画面読み込みを待って続行する。
        reportProgress(90, `「${r.label || 'タブ'}」に切り替えています…`);
        await new Promise((res) => setTimeout(res, 2000));
        await waitForContentReady(mainTabId);
        continue;
      }
      if (r.phase === 'remarkFilled') {
        // 備考（計画予定表タブ）を入力して停止。人が「登録する」を押してから再実行してもらう。
        reportProgress(95, '備考を入力しました。');
        message = '計画予定表タブの「備考」を入力しました。ここで一旦停止します。\n\n【次の手順】\n① 内容を確認して、ご自身で計画書の「登録する」を押して保存する\n② 保存後、同じJSONのままもう一度「自動入力を実行」を押す\n→ 残りの入力（説明日など）に進み完了します。';
        break;
      }
      if (r.phase === 'supportFilled') {
        // 援助内容を1サービス分入力して停止（人が計画書の「登録する」で保存してから再実行）。
        message = `サービス${r.tabNo}の援助内容を入力しました。ここで一旦停止します。\n\n【次の手順】\n① 内容を確認して、ご自身で計画書の「登録する」を押して保存する\n② 保存後、同じJSONのままもう一度「自動入力を実行」を押す\n→ 次のサービスの追加に進みます（登録済みは自動でスキップ）。\n\n※サービス設定＋援助内容を1サービス分入れるごとに「登録する」を押す運用です。`;
        break;
      }
      if (r.phase === 'supportSwitch') {
        // 援助内容のタブ切替（保存済みの状態で切替＝移動確認は出ない）。進んでいなければ停止
        if (typeof r.next === 'number' && r.next <= prevSupportNext) {
          throw new Error(`援助内容のサービス${r.next}タブへの切替が進みません。ページを再読み込みして、同じJSONのままもう一度実行してください（入力済みのタブは自動スキップされます）。`);
        }
        prevSupportNext = r.next;
        reportProgress(85, `援助内容: サービス${r.next}のタブに切り替えています…`);
        await new Promise((res) => setTimeout(res, 2000));
        await waitForContentReady(mainTabId); // タブ切替による画面遷移→content.js再注入を待つ
        continue;
      }
      if (r.phase === 'service') {
        // 【新運用 2026/07/16 ユーザー指示】サービス設定を保存しても、ここでは停止しない。
        //   保険内 : 続けて同じサービスの援助内容を入力してから停止する
        //            （supportFilledで停止 → 人が計画書の「登録する」→ 再実行で次のサービスへ）
        //   保険外（移動支援）: 援助内容が無いため、連続で「新規追加する」から次のサービスを
        //            追加する。最後の1件を登録し終えたら停止して人が計画書の「登録する」を押す。
        const done = total - (r.remaining || 0);
        const kindLabel = r.kind === '移動支援' ? '移動支援（保険外）' : '保険内サービス';
        reportProgress(5 + (done / Math.max(1, total)) * 80, `${kindLabel} サービス${r.svcNo}を登録しました。画面の更新を待っています…`);
        await new Promise((res) => setTimeout(res, 6000)); // content側のポップアップ「登録する」クリック＋画面再読み込みを待つ
        // フェイルセーフ：保存が反映されず残り件数が減らないまま繰り返すのを防ぐ
        if (typeof r.remaining === 'number') {
          if (r.remaining >= prevRemaining) {
            throw new Error(`サービスの追加が進んでいません（残り${r.remaining}件のまま）。保存が反映されていない可能性があります。ページを再読み込みし、【保険外】タブも含めて登録状況を確認してから、同じJSONでもう一度実行してください（入力済みは自動スキップされます）。`);
          }
          prevRemaining = r.remaining;
        }
        if (r.kind === '移動支援' && (r.remaining || 0) <= 0) {
          message = `最後のサービス（移動支援・保険外）を登録しました。ここで一旦停止します。\n\n【次の手順】\n① 内容を確認して、ご自身で計画書の「登録する」を押して保存する\n② 保存後、同じJSONのままもう一度「自動入力を実行」を押す\n→ 備考（計画予定表タブ）・説明日の入力に進みます。`;
          break;
        }
        await waitForContentReady(mainTabId);
        continue;
      }
      if (r.phase === 'tabMissing') {
        // サービス設定は保存できたが、援助内容の「サービスN」タブがまだ画面に出ていない
        // （計画書の「登録する」で反映されるケース）。人に登録を頼んで停止する。
        message = `サービス${r.svcNo}を登録しましたが、援助内容の「サービス${r.svcNo}」タブがまだ画面に表示されていません。\n\n【次の手順】\n① ご自身で計画書の「登録する」を押して保存する\n② 保存後、同じJSONのままもう一度「自動入力を実行」を押す\n→ サービス${r.svcNo}の援助内容の入力から続きます。`;
        break;
      }
      // done: 保険内＋移動支援（保険外）のサービス・援助内容・説明日まで完了
      message = `サービス（保険内・移動支援）と援助内容・説明日の下書き入力が完了しました。目視確認のうえ、作成状態を「作成済」にしてご自身で「登録する」を押してください。\n\n※移動支援（保険外）は【保険外】タブで登録内容をご確認ください。`;
      break;
    }
    if (allSkipped.length) {
      message += '\n\n⚠ 自動選択できなかった項目があります。カイポケの画面で手動選択・確認してください：\n・' + allSkipped.join('\n・');
    }
    return { ok: true, message: message + MANUAL_NOTE };
  }
  // 要介護/要支援: 別ウィンドウ調整（1回の実行で1サービスずつ）
  const isYoshien = String(modeInfo.label || '').indexOf('要支援') >= 0;
  const result = await orchestrate(payload, mainTabId, isYoshien);
  let message;
  if (result.needSaveFirst) {
    message = 'ここで一旦停止しました（エラーではありません。カイポケの新規画面ではサービス追加ができない仕様のため）。\n\n【再開のしかた】\n① 入力内容を確認し、ご自身で「登録する」を押して保存する（作成状態は「作成中」のまま）\n② 保存後に開く編集画面で、同じJSONのままもう一度「自動入力を実行」を押す\n→ サービスは1回の実行で1件ずつ入力されます（入力済みは自動スキップ）。';
  } else if (result.remaining > 0) {
    message = `サービス${result.skippedCount + result.processed}を入力しました（全${result.total}件中 ${result.skippedCount + result.processed}件済み・残り${result.remaining}件）。\n\nカイポケの仕様により、1回の実行で登録できるサービスは1件です。\n① 内容を確認して「登録する」で保存\n② 保存後の編集画面で、同じJSONのままもう一度「自動入力を実行」\n→ 入力済みのサービスは自動でスキップされます。`;
  } else if (result.processed === 0 && result.total > 0) {
    message = `サービス全${result.total}件はすべて入力済みでした。説明日・説明者を入力して完了しました。目視確認のうえ、作成状態を「作成済」にしてご自身で「登録する」を押してください。`;
  } else {
    message = `全サービス${result.total}件の入力が完了しました。説明日・説明者まで入力済みです。目視確認のうえ、作成状態を「作成済」にしてご自身で「登録する」を押してください。`;
  }
  if (result.svcWarnings && result.svcWarnings.length) {
    message += '\n\n⚠ サービス設定で自動選択できなかった項目があります。カイポケの画面で該当サービスを開き、手動で選択・確認してください：\n・' + result.svcWarnings.join('\n・');
  }
  return { ok: true, message: message + MANUAL_NOTE };
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
    startAutofill(message.payload, mainTabId)
      .then((result) => {
        reportProgress(100, '完了しました');
        clearBadgeLater();
        sendResponse(result);
      })
      .catch((err) => {
        reportErrorBadge();
        sendResponse({ ok: false, message: err && err.message ? err.message : String(err) });
      });
    return true; // 非同期応答
  }
});
