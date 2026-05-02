# CLAUDE.md

このリポジトリ (`@csbc-dev/stripe`) は [`@wc-bindable/stripe`](https://github.com/wc-bindable-protocol/wc-bindable-protocol/tree/main/packages/stripe) を起点として、csbc-dev/arch のアーキテクチャ群の一員として再パッケージしたものです。設計思想を理解するうえで前提となる 2 つのドキュメントを以下にまとめます。

---

## 1. wc-bindable-protocol の概要

`EventTarget` を継承する任意のクラスが、自身のリアクティブなプロパティを宣言するためのフレームワーク非依存・最小プロトコル。React / Vue / Svelte / Angular / Solid などのリアクティビティシステムが、フレームワーク固有のグルーコードを書かずに任意のコンポーネントに束縛できるようにする。

### コアアイデア

- コンポーネント作者は **何が** バインド可能かを宣言する
- フレームワーク利用側は **どう** バインドするかを決める
- 双方は互いを知らなくてよい

### 宣言の仕方

`static wcBindable` フィールドにスキーマを書くだけ。

```javascript
class MyFetchCore extends EventTarget {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value",   event: "my-fetch:value-changed" },
      { name: "loading", event: "my-fetch:loading-changed" },
    ],
    inputs:   [{ name: "url" }, { name: "method" }],   // 任意
    commands: [{ name: "fetch", async: true }, { name: "abort" }],  // 任意
  };
}
```

| フィールド | 必須 | 役割 |
|---|---|---|
| `properties` | ✅ | 状態変化を `CustomEvent` で通知するプロパティ群（出力） |
| `inputs` | — | 設定可能なプロパティ（入力。宣言のみで自動同期はしない） |
| `commands` | — | 呼び出し可能なメソッド（リモートプロキシやツーリング向け） |

### バインドの仕組み

アダプタは以下を行うだけ：

1. `target.constructor.wcBindable` を読む
2. `protocol === "wc-bindable" && version === 1` を確認
3. 各 `property` について `target[name]` を即時読み取って初期値を配信し、続いて `event` を購読する

`bind()` は実装たかだか 20 行。フレームワークアダプタも数十行で書ける。

### スコープ外（意図的）

- 自動双方向同期（入力反映は呼び出し側の責任）
- フォーム統合
- SSR / hydration
- 値の型検証 / スキーマ検証

### なぜ EventTarget か

`HTMLElement` ではなく `EventTarget` を最小要件にしているため、Node.js / Deno / Cloudflare Workers などブラウザ外ランタイムでも同じプロトコルが動作する。`HTMLElement` は `EventTarget` のサブクラスなので Web Components は自動的に互換。

参考: [wc-bindable-protocol/SPEC.md](https://github.com/wc-bindable-protocol/wc-bindable-protocol/blob/main/SPEC.md)

---

## 2. Core/Shell Bindable Component (CSBC) アーキテクチャの概要

wc-bindable-protocol を土台に、**業務ロジック（特に非同期処理）をフレームワーク層から Web Component 側に移すこと** で、フレームワークロックインを構造的に解消するアーキテクチャ。

### 解こうとする問題

フレームワーク移行コストの真の発生源は UI の互換性ではなく、**フレームワーク固有のライフサイクル API（`useEffect` / `onMounted` / `onMount` …）と密結合した async ロジック** である。テンプレートは機械的に書き換えられても、async コードは意味理解を要求するため移植コストが跳ね上がる。

### 三層構造

1. **Headless Web Component 層** — fetch / WebSocket / タイマー等の async 処理と状態 (`value`, `loading`, `error`, …) を内部に封じ込める。UI は持たず、純粋なサービス層として振る舞う。
2. **Protocol 層 (wc-bindable-protocol)** — 上記の状態を `static wcBindable` + `CustomEvent` で外に開く。
3. **Framework 層** — 薄いアダプタでプロトコルに接続し、受け取った状態を描画する。**async コードはここに一切書かない**。

### Core / Shell の分離

Headless 層は更に二つに分解される。**唯一の不変条件は「Shell が常に薄い」ことではなく、決定権の所在**：

- **Core (`EventTarget`) — 決定を持つ**
  業務ロジック、ポリシー、状態遷移、認可関連の振る舞い、イベント発火。DOM 非依存にできれば Node.js / Deno / Workers にも持ち運べる。
- **Shell (`HTMLElement`) — 委譲できない実行のみを持つ**
  フレームワーク接続、DOM ライフサイクル、ブラウザでしか実行できない処理。

設計上の鍵は **target 注入** パターン: Core のコンストラクタが任意の `EventTarget` を受け取り、すべてのイベントをそこへディスパッチする。Shell が `this` を渡せば、Core のイベントが直接 DOM 要素から発火し、再ディスパッチが不要になる。

### 4 つの正準ケース

| ケース | Core の場所 | Shell の役割 | 例 |
|---|---|---|---|
| A | ブラウザ | ブラウザ依存 Core の薄いラッパ | `auth0-gate` (local) |
| B1 | サーバ | コマンド仲介・プロキシ型の薄い Shell | `ai-agent` (remote) |
| B2 | サーバ | 観測専用の薄い Shell（リモートセッション購読のみ） | `feature-flags` |
| C | サーバ | ブラウザ固定のデータプレーンを実行する Shell | `s3-uploader`, `passkey-auth`, **`stripe-checkout`** |

ケース C は CSBC の **第一級のケース**。ブラウザでしか実行できないデータプレーン（直接アップロード、WebRTC、WebUSB、`File System Access API`、ユーザジェスチャ依存の処理、PCI スコープを避けるための Stripe Elements など）が存在するときに発生する。Shell が太くなっても、**意思決定が Core にある限り** CSBC 違反ではない。

> 不変条件:
> **Core はすべての決定を持つ。Shell は委譲できない実行だけを持つ。**

### 横断する 3 つの境界

| 境界 | 横断する主体 | メカニズム |
|---|---|---|
| ランタイム境界 | Core (`EventTarget`) | DOM 非依存。Node / Deno / Workers で動作 |
| フレームワーク境界 | Shell (`HTMLElement`) | 属性マッピング + `ref` バインディング |
| ネットワーク境界 | `@wc-bindable/remote` | プロキシ EventTarget + JSON ワイヤープロトコル |

`@wc-bindable/remote` は `RemoteShellProxy`（サーバ側）と `RemoteCoreProxy`（クライアント側）のペアで、Core をサーバへ完全に押し出しつつクライアント側の `bind()` を変えずに動かす。トランスポートは WebSocket がデフォルトだが、最小インタフェース (`ClientTransport` / `ServerTransport`) を満たせば MessagePort / BroadcastChannel / WebTransport などに差し替え可能。

### 本パッケージにおける位置付け

`@csbc-dev/stripe` は **ケース C**: Stripe 決済の決定（PaymentIntent / SetupIntent の生成、webhook 検証、3DS resume 認可）はすべて `StripeCore` (Core, `EventTarget`) がサーバ側で持ち、`<stripe-checkout>` (Shell, `HTMLElement`) はブラウザでしか実行できないデータプレーン — Stripe.js のロード、Stripe-sandboxed iframe による Payment Element のマウント、`confirmPayment` / `confirmSetup`、3DS redirect の戻りハンドリング — を担当する。

カード情報は WebSocket を一切経由しない（Stripe Elements が iframe 内から直接 Stripe へ POST する）。サーバ側を通るのは PaymentIntent 生成リクエスト、確認結果、webhook 由来のステータス更新のみ。これにより `STRIPE_SECRET_KEY` をブラウザに渡さず、PCI スコープを拡大せずに、CSBC の不変条件「Core が決定を持ち、Shell は委譲できない実行だけを持つ」を維持している。

参考: [csbc-dev/arch](https://github.com/csbc-dev/arch/blob/main/README.md)
