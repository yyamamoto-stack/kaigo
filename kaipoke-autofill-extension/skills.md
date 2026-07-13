# skills.md — コアスキル定義（DOM 操作の基礎関数）

本拡張機能の DOM 操作は、以下の**4つのコアスキル**を土台とします。
`content.js` はこれらを組み合わせて処理フローを構築します。
新しい操作を実装する際は、必ずこれらのスキルを使い、スリープ・タイムアウト・
ネイティブイベント発火のルール（`claude.md` 参照）を逸脱しないでください。

---

## 1. `sleep(ms)` — 遅延処理

人間の操作スピードを模倣するための待機関数。
**すべてのアクションの間に必ず挟む**こと（`claude.md` 1-2 参照）。

```js
/**
 * 指定ミリ秒だけ待機する（Promise ベース）。
 * @param {number} ms 待機ミリ秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 500〜1500ms のランダムな待機を行う（人間の操作揺らぎを模倣）。
 * アクション間の標準スリープとして使用する。
 * @returns {Promise<void>}
 */
function humanSleep() {
  // 500 以上 1500 以下のランダムなミリ秒
  const ms = 500 + Math.floor(Math.random() * 1001); // 500〜1500
  return sleep(ms);
}
```

---

## 2. `waitForElement(selector, options)` — 要素の出現待機

DOM に対象要素が現れるまで**ポーリングで待機**する。
**必ずタイムアウトを設け**、時間内に見つからなければ例外を投げて安全に停止させる
（`claude.md` 1-3 参照）。

```js
/**
 * 指定セレクタの要素が DOM 上に出現するまで待機する。
 * タイムアウト（既定 10 秒）を超えた場合は例外を投げ、呼び出し側で安全停止させる。
 *
 * @param {string} selector CSS セレクタ
 * @param {object} [options]
 * @param {number} [options.timeout=10000] タイムアウト（ミリ秒）
 * @param {number} [options.interval=200]  ポーリング間隔（ミリ秒）
 * @param {Element} [options.root=document] 探索の起点（モーダル内探索などで使用）
 * @param {boolean} [options.visible=true]  表示状態（display/visibility）まで確認するか
 * @returns {Promise<Element>} 見つかった要素
 * @throws {Error} タイムアウト時
 */
function waitForElement(selector, options = {}) {
  const {
    timeout = 10000,   // 【暴走防止】既定 10 秒でタイムアウト
    interval = 200,    // 200ms ごとに確認
    root = document,
    visible = true,
  } = options;

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    // 要素が「表示されている」かの簡易判定
    const isVisible = (el) => {
      if (!visible) return true;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      // offsetParent が null（非表示）でないこと、サイズがあることを確認
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const tick = () => {
      const el = root.querySelector(selector);
      if (el && isVisible(el)) {
        resolve(el);
        return;
      }
      // タイムアウト判定
      if (Date.now() - startedAt >= timeout) {
        reject(new Error(`waitForElement タイムアウト: "${selector}" が ${timeout}ms 以内に見つかりませんでした。`));
        return;
      }
      setTimeout(tick, interval);
    };

    tick();
  });
}
```

---

## 3. `setNativeValue(element, value)` — イベント強制発火を伴う値設定

`element.value = x` の単純代入では、React / Vue などの制御コンポーネントが
値の変化を検知できず、入力が「なかったこと」にされる場合があります。
そこで**ネイティブの value セッターを直接呼び、`input` / `change` イベントを強制発火**させます。

```js
/**
 * input / textarea / select に値を設定し、フレームワークが検知できるよう
 * ネイティブの value セッターを用いて input / change イベントを強制発火する。
 *
 * @param {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} element 対象要素
 * @param {string} value 設定する値
 */
function setNativeValue(element, value) {
  if (!element) {
    throw new Error('setNativeValue: 対象要素が null です。');
  }

  // 要素のプロトタイプからネイティブの value セッターを取得する
  const prototype = Object.getPrototypeOf(element);
  const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
  const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

  // React が上書きしたセッターを回避し、ネイティブセッターで値を入れる
  if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
    prototypeValueSetter.call(element, value);
  } else if (valueSetter) {
    valueSetter.call(element, value);
  } else {
    element.value = value; // フォールバック
  }

  // フレームワークに変更を通知するためのイベントを発火
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}
```

---

## 4. `safeClick(element)` — 安全なクリック

対象がクリック可能な状態（存在・表示・非 disabled）であることを確認してから
クリックを行うヘルパー。スクロールで可視化してからクリックします。

```js
/**
 * 要素を安全にクリックする。
 * - null / disabled の場合は例外を投げて安全停止させる
 * - 画面内にスクロールしてから、実際のマウス操作に近いイベントで押下する
 *
 * @param {Element} element クリック対象
 * @throws {Error} 要素が無効な場合
 */
function safeClick(element) {
  if (!element) {
    throw new Error('safeClick: クリック対象が null です。処理を停止します。');
  }
  if (element.disabled) {
    throw new Error('safeClick: クリック対象が disabled 状態です。処理を停止します。');
  }

  // 対象を画面内に入れる（人間の操作に近づける）
  element.scrollIntoView({ block: 'center', inline: 'center' });

  // フォーカス → クリック（可能ならネイティブに近いイベントを発火）
  if (typeof element.focus === 'function') {
    element.focus();
  }
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  element.click();
}
```

---

## 5. 使い方の原則（コアスキルの組み合わせ）

処理フローでは、これらのスキルを**必ずスリープで挟みながら**組み合わせます。

```js
// 例：ボタンを待って押し、少し待つ
const btn = await waitForElement(SELECTORS.someButton); // 出現待機（タイムアウトあり）
await humanSleep();                                     // 人間らしい待機
safeClick(btn);                                         // 安全クリック
await humanSleep();                                     // 次の操作まで待機

// 例：テキスト入力（ネイティブイベント発火つき）
const input = await waitForElement(SELECTORS.someInput);
await humanSleep();
setNativeValue(input, '入力したい値');
await humanSleep();
```

**禁止:** スリープを省いた連続操作、タイムアウトなしの待機、
`element.value = x` だけの入力（`claude.md` 参照）。

---

## 6. 追加スキル（v2：実画面対応で追加）

実際のカイポケ計画書画面はラジオ・チェックボックス・和暦プルダウンを多用するため、
以下の派生スキルを `content.js` に実装している（実装本体は `content.js` を正とする）。

- `setRadio(selector)` … ラジオを選択し change を発火（安全クリックも併用）。
- `setCheckbox(selector, checked)` … 現在状態と異なる時だけクリックして希望状態にする。
- `selectOption(selector, value)` … value か表示テキストで select を選択（不一致は安全停止）。
  部分一致もフォールバックで試すが、原則は**カイポケ登録値と完全一致**する文字列を渡す。
- `setWarekiDate(dateSelectors, "令和8年7月13日")` … 元号/年/月/日の select 群へ和暦を設定。
- `parseWareki(str)` … 和暦文字列を `{era, year, month, day}` に分解。

いずれも各操作間に `humanSleep()` を挟むこと（連続リクエスト回避）。

## 7. 親子ウィンドウの調整（background.js）

サービス設定は**別ウィンドウ（ポップアップ）**で開くため、DOM操作は行わず順序制御だけを担う
`background.js`（Service Worker）を置く。メイン画面と各ポップアップの `content.js` を
メッセージで仲介し、「基本情報→（サービスごとに）ポップアップ入力→援助内容タブ入力→説明欄」の
順に進める。`background.js` でも fetch 等の外部通信は行わない（中継と待機のみ）。
