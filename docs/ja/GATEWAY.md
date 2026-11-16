# 実用版 v1 ゲートウェイ

既定はチェーン無し。Node 24 以上、既存の `@bsv/sdk` と Node 標準（http/sqlite/crypto）だけを使う。

```sh
npm ci --prefix authority
npm test                 # covenant + チェーン無し + BSV アダプタ
npm run demo            # チェーン無し：会社A→B→子AI2体→モックAPI
npm run demo:bsv        # 同じシナリオを BSV covenant + メモリチェーンで実行
```

## 台帳の差し替え

ゲートウェイは権限の正本に `Ledger` インタフェースだけで接続する。自分で BSV の取引・スクリプト・確認数を読まない。

- `readTranche(id)` → `{id, holder, R, d, n, P, T, phase}` または未取得。
- `isSpent(id)` → boolean。欠落・例外・boolean 以外なら呼び出しを許可しない。
- `settle(id, k, {key, lockTime})` → `{ok, settled, kind, k, record?, ...}`。`settled` は台帳で確定済みか、`record` は未確定の組み立て結果を保存できる JSON 記述。

`MemoryLedger` はメモリ上の SQLite、`SqliteLedger({filename})` は永続 SQLite。チェーン・ヘッダ・確認待ちが無い。`issue` と `delegate` は信頼する管理者のローカル API で、HTTP には公開しない。委任では残数合計・P の縮小・T の短縮・所有鍵・深さを検査し、元の束を一度だけ消費する。精算は k を消費して残数の新しい束を返す。同じ精算の再試行は同じ結果を返す。

`Gateway` で `ledger` を省略すると、メモリまたは指定した `filename` 内の SQLite 台帳を自動で作る。使用記録と権限の正本は別のテーブルに保存する。複数のゲートウェイプロセスで同じ束を処理するときは、使用記録の SQLite ファイルも共有する。

```js
import { Gateway, publicKey, createServer } from './gateway/index.mjs';
// key と agent は既存 @bsv/sdk の PrivateKey。secret をソースやログに置かない。
const gateway = new Gateway({
  key, filename: '/absolute/private/gateway.sqlite',
  operations: { 'POST /mock': 1, 'GET /read': 2 },
});
const id = gateway.ledger.issue({
  holder: publicKey(key), ancestors: [publicKey(agent)], n: 100,
  P: 1, T: Math.floor(Date.now() / 1000) + 3600,
});
await gateway.bind(id, [publicKey(agent)]);
const server = createServer(gateway, { execute: async request => ({ ok: true }) });
server.listen(8080, '127.0.0.1');
```

## BSV アダプタ

`new BsvLedger({chain, minConfirmations: 1})` を `Gateway` に渡す。`minConfirmations` は必ず整数の1以上。0・未確認の UTXO は bind で拒否する。covenant 発行時のヘッダ待ちパラメータとは別の預け入れ確認ポリシー。加えて既定では、covenant の作業量の下限がメインネット難易度の1/4より緩い束（K<2 を含む）は bind を拒否する（`maxTarget`・`minK` で変更。緩めるのはテストだけ）。

`chain` は `async getUtxo(id)` と `async isSpent(id)` を実装する。UTXO 記述子は `{txid,vout,satoshis,script,params,confirmations}`。`script` は SDK の LockingScript、`params` は発行時の K/target、`confirmations` は canonical chain 上の実際の確認数。アダプタがスクリプトから n/P/T/holder/R を読み、コード全体も照合する。渡された `utxo.state` は信用しない。

`MemoryChain` はテスト専用。`put(utxo, {confirmations: 1})` は確認したと**仮定する指定**で、実チェーンの証明ではない。省略時は0。実ノードアダプタは未実装。

## 呼び出し・停止・精算

`sign(key, {tranche, method, path, body, nonce})` で署名する。ドメイン、HTTP メソッド、パス、本文の SHA256、nonce、束 ID を署名対象にする。`X-Tranche`, `X-Agent-Key`, `X-Nonce`, `X-Agent-Sig` に設定する。操作ビットは要求者に選ばせずサーバーのルート表で決める。

`bind(id, ancestors)` はゲートウェイ鍵への預け入れ・完全な祖先列の長さ d・ROOT_R からのハッシュ R を検査する。署名して使えるのは開示列末尾の預けたエージェントだけ。`authorize(request)` は毎回、台帳の消費状態・署名・範囲・期限を検査し、BEGIN IMMEDIATE で nonce・残数減算・署名記録をまとめて確定する。API が失敗しても許可した1回として数える。本文は保存せずハッシュだけを記録する。

HTTP は `POST /bind` に `{"ancestors":["圧縮公開鍵", "..."]}`、`POST /stop` に任意の署名対象本文、他は設定した操作ルートへ送る。すべて署名ヘッダ必須。bind の署名者は開示列末尾、stop は祖先列内の鍵に限る。Cookie を使わず、メソッド・パス・本文に結び付く署名で CSRF と改ざんを防ぐ。全ルートに IP 単位のレート制限・本文上限・タイムアウトを適用し、内部エラーを HTTP に返さない。

祖先の停止は対象の束だけに適用する。子孫全体を探索する API ではなく、停止したい各束の ID が必要。停止時に未精算の使用回数があれば、**停止と同じトランザクションで k を精算待ちに記録**する。`pendingSettlements()` で取得でき、再起動後も残る。兄弟の束は継続する。

`settle(id)` は記録済み k で束を凍結し、Ledger の精算を呼ぶ。SQLite は残りの新しい束を返して精算完了とする。BSV は USE_K の予告取引を組み立てるだけなので `built` のまま精算待ちに残す。実チェーンで予告が確認された後は `buildSettle(pendingUtxo, {key, k, lockTime, headers, merkleProof})` で確認取引を作る。`transaction.toHex()` は確認可能な成果物であり、自動送信しない。k=0 は精算できない。

`monitor()` は登録済み束の消費を調べて停止する。毎回の authorize でも照会する。使用記録は `receipts(id)`。`close()` と HTTP の `close()` は呼出側の責務。注入した Ledger は呼出側で閉じる。ゲートウェイが自動で作った Ledger はゲートウェイと一緒に閉じる。

## 信頼の前提・未対応

SQLite 構成では台帳の管理者を信頼する。BSV 構成でも、API 当事者のゲートウェイが使用回数を正しく数え、正しい k で精算すること、チェーンアダプタが正しい canonical chain を返すことを信頼する。BSV が手元の API 消費を強制するわけではない。

停止時の k 記録は没収より先にチェーンで精算される保証ではない。精算前に祖先が没収すれば、既に使用した回数も回収され得る。署名記録は呼び出しの許可の証拠で、API 成功の証明ではない。v0.4 の浮遊する偽ヘッダ／canonical chain の制約も変わらない。

実資金・実ネットワーク送信・regtest アダプタ・自動争議・自動の予告確認／精算後の残数引継ぎ・分散複数 DB・TLS/公開運用は未対応。HTTP はローカルの組み込み用。本番の耐 DoS、DB バックアップ、再編対応は別途必要。台帳照会と API 実行の間に消費される競合窓もある。

p50/p99 は localhost HTTP の要求について「署名検査＋台帳照会＋SQLite 確定」を測る。署名生成・HTTP 往復は含まない。デモはメモリ DB であり、永続ディスク・実ノードの性能保証ではない。
