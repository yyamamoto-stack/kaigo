// injected.js（メインワールドで実行される外部スクリプト）
// カイポケの計画書ページは CSP `script-src 'self'` でインラインスクリプトを禁止しているため、
// content.js からのインライン注入（textContent）は弾かれる（v2.10.2で判明）。
// そこで拡張機能同梱の【外部ファイル】として読み込む（CSPの script-src 許可リストに拡張機能の
// オリジンが含まれるため、この方法なら実行できる）。web_accessible_resources に登録が必要。
//
// 役割：カイポケの dirtyチェック（入力変更後にサービス追加ボタン・援助内容タブなどの
// フォーム送信リンクを押すと「このページからほかのページに移動しますか？」の確認が出る）を
// 無効化する。これらのリンクは押せば結局フォームを送信して入力を保存するため、確認は不要。
// window.onbeforeunload も無効化し、ブラウザの離脱警告も止める。
// 注入が実行できたことを sessionStorage 経由で content.js へ知らせる（診断用）。
(function () {
  try {
    if (!window.__kaipokeDirtyPatched) {
      window.__kaipokeDirtyPatched = true;
      // dirtyCheckA4J() が false を返すと、onclick の `if(dirtyCheckA4J()){return false;}` を
      // 素通りして本来の送信（oamSubmitForm）が実行される＝確認ダイアログなしで保存される。
      window.dirtyCheckA4J = function () { return false; };
      try { window.onbeforeunload = null; } catch (e) {}
    }
    try { sessionStorage.setItem('kaipokeAutofillInject', 'ok'); } catch (e) {}
  } catch (e) {
    try { sessionStorage.setItem('kaipokeAutofillInject', 'err:' + (e && e.message)); } catch (_) {}
  }
})();
