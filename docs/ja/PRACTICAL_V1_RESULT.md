# 実用版 v1 — 実装・検証結果

2026-11-16 / Task: 1116-authority-practical / Agent: codex

## 判定

`docs/PRACTICAL_V1.md` の受入条件1〜5、および追加指定の Ledger 差し替え・BSV 確認数1以上・停止時の未精算 k の原子記録を実装し、CI で検証した。既定はチェーン無しの SQLite 台帳。BSV covenant は任意の Ledger アダプタ。

検証したコード: `9d6acc232c427e776df4308272cfdd872201d3a7`。

最終 GREEN / GitHub Actions 43833746501 (historical CI run 43833746501)。`npm test`、`npm run demo`、`npm run demo:bsv` がすべて成功。

ローカルはマシン全体の負荷が高く、指定の負荷条件を満たせなかったため重いテストを開始しなかった。ローカルでは構文・差分検査を行い、テスト・デモ・以下の性能測定は GitHub `ubuntu-latest` / Node 24 の runner 上で実行した。ローカル Mac や実ノードの性能を示す値ではない。

## テスト先行の証拠

- 最初の RED / 28e38e0 / CI 43831023337 (historical CI run 43831023337): 99件中96成功・3失敗。既存の k=1 は維持される一方、k=n の残数誤り、k=0 と k>n の誤受理を新テストが検出した。
- Ledger 追加の RED / e651457 / CI 43832493142 (historical CI run 43832493142): 既存側99件成功、未実装の `MemoryLedger` / `BsvLedger` を要求する2テストファイルが失敗した。
- 最終 GREEN: **131件成功、失敗0**。実行コマンドは `nice -n 15 node --test --test-concurrency=1 authority/*.test.mjs gateway/*.test.mjs`。追加委譲なし。

## 構成別の検証

| 対象 | 件数 | 結果 |
|---|---:|---|
| 既存 authority | 91 | 全成功。既存 k=1 使用・委任・奪還・v0.4 テストを維持 |
| USE_K | 8 | 全成功。k=1、k=n、k=0拒否、k>n拒否、P/T拡大拒否。拡大を先に予告へコミットしても確認の `hashOutputs` で拒否 |
| チェーン無し / gateway/gateway.test.mjs | 17 | 全成功。SQLite のみで受入条件2〜3、HTTP、永続化、精算・再試行、委任の保存則、任意 Ledger の差し替えを検証 |
| BSV / gateway/bsv.test.mjs | 15 | 全成功。受入条件2〜3、スクリプトからの状態読出、確認数0拒否・ポリシー0拒否、停止後の精算待ち k 記録、USE_K の予告・確認組み立てを検証 |

両構成とも、正しい署名だけを受理し、別鍵・範囲外・期限切れ・nonce 再送・残数0・停止後を拒否する。100呼び出しを同時に開始し、n=17 の束からちょうど17件を通し、残数0を確認した。祖先列の各位置から停止でき、祖先列外の鍵は拒否し、兄弟の束は通り続ける。

未精算の2回を使ってから停止すると、停止と同一の SQLite トランザクションで k=2 が精算待ちに残る。チェーン無し構成では残数8の新しい束へ精算でき、再試行でも再消費しない。既定の永続 SQLite 構成では再起動後も残数・nonce・署名記録・停止・精算待ちを保持する。BSV は取引を組み立てても `built` のまま待ち行列へ残し、オンチェーン精算完了と偽らない。

## デモ実測

会社Aの1000回を会社Bへ渡し、子AI2体へ各500回ずつ分ける。両方をモック API へ通した後、Bの署名で子AI1だけを停止する。子AI1の次の呼び出しは403、子AI2はその後3回成功し、残数が240→237になる。

| 構成 | サンプル | p50 | p99 | p99 < 5ms |
|---|---:|---:|---:|---|
| npm run demo / チェーン無し・メモリ SQLite | 500 | 0.563ms | 0.875ms | 達成 |
| npm run demo:bsv / BSV＋メモリチェーン | 500 | 1.200ms | 2.024ms | 達成 |

各構成は子AIごとに最初の10回をウォームアップとして除外し、残る250回ずつを集計した。測定は実際の localhost HTTP 要求に対する署名検査・Ledger 照会・使用台帳のトランザクション確定の時間。クライアントの署名生成と HTTP 往復を除く。モック API は各構成523回成功。片方停止後の兄弟継続を assertion でも検証した。

## スクリプトサイズ

同一の114バイト状態形式、target=(2^240)-1 のロックスクリプトを比較。

| 発行パラメータ | v0.4 / 0e01944 | USE_K | 増加 |
|---|---:|---:|---:|
| K=2 | 3243 bytes | 3257 bytes | +14 bytes |
| K=73 | 13921 bytes | 13938 bytes | +17 bytes |

k は使用パスの unlock 引数として渡す。スクリプトが `1 <= k <= n` を検査し、同じ holder/R/P/T/d とコードを保持して `n-k` の出力に拘束する。k の省略は既存互換の1。

## 信頼と未対応

SQLite 構成は管理者による発行・委任台帳を信頼する。BSV 構成も、ゲートウェイによる正しい利用回数の計数と、アダプタによる canonical chain・確認数の正しさを信頼する。ゲートウェイは Ledger の `readTranche` / `isSpent` / `settle` だけを通じて権限の正本に触れ、精算の確定判定もアダプタ種類名ではなく `settled` フラグを使う。

BSV のテストはメモリアダプタが確認数を仮定し、SDK `Spend.validate` がスクリプトを評価する。実ノード・regtest・実チェーンの確認を試した結果ではない。v0.4 の浮遊ヘッダと canonical chain の区別も解消していない。

停止時の k の記録は、祖先の没収より精算が先に確定する保証ではない。没収が先なら未精算分も回収され得る。自動争議は作っていない。署名記録は許可の証拠で、API 成功の証明ではない。

実資金・メインネット／実ネットワーク送信・regtest アダプタ・自動の予告確認・精算後の自動引継ぎ・分散複数 DB・公開用 TLS／運用監視／バックアップは未対応。台帳照会と API 実行の間の競合窓もある。

## 変更ファイル

- `.github/workflows/practical-v1.yml`: RED/GREEN と両デモの CI。
- `authority/lib/cov/script.mjs`: USE_K のスクリプト範囲検査と減算。
- `authority/lib/cov/spend.mjs`: k 引数・出力・組み立てた Transaction の返却。
- `authority/lib/cov/index.mjs`: spendUseK の公開。
- `authority/package.json`, `authority/use-k.test.mjs`: 新しい covenant 検証。
- `gateway/index.mjs`: SQLite の利用台帳、署名許可、bind、停止、監視、精算待ち。
- `gateway/auth.mjs`: 署名形式・検証・公開鍵・祖先ハッシュ。
- `gateway/ledger.mjs`: Ledger インタフェース、MemoryLedger / SqliteLedger。
- `gateway/bsv.mjs`: BsvLedger、MemoryChain、USE_K 精算ビルダー。
- `gateway/http.mjs`: ローカル HTTP の bind／停止／API、上限・エラー処理。
- `gateway/gateway.test.mjs`, `gateway/bsv.test.mjs`: 構成別の受入テスト。
- `gateway/demo.mjs`: 両構成の実行と p50/p99。
- `gateway/package.json`, `package.json`: Node 24 ESM の実行コマンド。
- `gateway/README.md`, `docs/PRACTICAL_V1_RESULT.md`: 使い方・信頼・制限・実測。

開始時から存在した `authority/lib/cov/intent.mjs` / `script.mjs.baktest` と、親が追加した `docs/PRACTICAL_V1_CRITIQUE.md` は保護し、今回のコミットへ混ぜていない。PR作成・マージ・取引の送信はしていない。
