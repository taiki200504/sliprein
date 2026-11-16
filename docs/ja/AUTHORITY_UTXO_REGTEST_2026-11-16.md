# Authority UTXO v0.4 — BSV regtest 実ノード検証（2026-11-16 JST）

## 結論

正常な発行・予告・実ブロック証明による確定・祖先奪還・委任・子の使用は、Bitcoin SV Node 1.2.3 の regtest で受理され、採掘ブロックに含まれた。単一入力・手数料0の covenant 遷移は `minrelaytxfee=0` / `minminingtxfee=0` の設定で通った。

**浮遊ヘッダの確定も受理・採掘された。要求された否定系はこの項目が不合格であり、実チェーン上の K ブロック待機は保証されない。** 本検証では covenant スクリプトを修正していない。

## 実行条件・一次資料

- [公式 BSV Docker 手順](https://docs.bsvblockchain.org/network-topology/nodes/sv-node/installation/sv-node/docker) と [公式 Docker Hub](https://hub.docker.com/r/bitcoinsv/bitcoin-sv) が示す `bitcoinsv/bitcoin-sv` を利用。
- イメージを digest 固定: `sha256:d96fe4786a00e5fc10bc9e0e76a6006376f9472d4eb74d07e4c1e0d019493d33`、linux/amd64。ノード `/Bitcoin SV:1.2.3/`、protocol 70016。
- `--network none`、ホスト公開ポート・ホストボリュームなし、regtest 専用。Docker 内の `bitcoin-cli -regtest` を `docker exec` で呼ぶ。メインネット・テストネット・実資金は使用しない。
- Docker `--cpus 4 --memory 3072m`。実行は `heavy` 経由。独立した使い捨てコンテナを EXIT/INT/TERM trap で停止・削除。
- Genesis スクリプト有効化を `-genesisactivationheight=1` に固定。非標準取引許可、stack memory policy/consensus 各100,000,000B、ブロック上限100,000,000B。公開ネットワークの既定ポリシーの合格を意味しない。
- `K=2`、実 regtest の `nBits=0x207fffff` に対応する target `0x7fffff << 232` を発行時に固定。
- 最初に regtest 105ブロックを採掘し、成熟済み coinbase から権限UTXOを発行。発行は通常 wallet 署名、1000 sat 手数料。権限UTXOは10000 sat、委任は5000 satずつ2子へ。
- covenant 遷移は既存 builder の `Transaction.prototype.id` 呼び出し時にシリアライズ済み raw を捕捉するテスト用アダプターで送信。`authority/lib/cov/` は変更しない。
- SDK 正確版・txid・ブロックhash・RPCエラー全文・入力数・手数料は [`authority/regtest/results.json`](../../research/authority-utxo/authority/regtest/results.json) に記録。

## 結果

| 操作 | SDK Spend.validate | sendrawtransaction / 採掘 |
|---|---|---|
| 権限UTXO発行（各系統） | wallet署名 | 受理・取り込み |
| 使用の予告 | true | 受理・取り込み |
| 実ヘッダ・実Merkle証明による使用確定 | true | 受理・取り込み |
| 予告後の祖先奪還 | true | 受理・取り込み |
| 委任の予告・確定 | true | 受理・取り込み |
| 子の予告・実ヘッダによる使用 | true | 受理・取り込み |
| 確定が取り込まれた後の同じ入力の奪還 | true | 拒否 `-25: Missing inputs` |
| 奪還が取り込まれた後の同じ入力の確定 | true | 拒否 `-25: Missing inputs` |
| 確定をmempoolへ入れた後の競合奪還 | true | 拒否 `-26: 258: txn-mempool-conflict` |
| 浮遊ヘッダによる確定（拒否が期待されたケース） | true | **受理・取り込み（不合格）** |

正常系の確定は、予告を含むブロックを取得し、実取引リストから SHA256d Merkle 分岐（coinbase と予告等）を組み立て、その後さらに実ブロック2本を採掘して、予告ブロック＋後続2本の80Bヘッダを渡す。ヘッダ nBits も照合する。

浮遊ケースでは、予告 txid を単独Merkle葉にした合成ヘッダ3本を regtest と同じ target 以下でローカル生成する。全ヘッダhashが `getblockheader` で未登録であることを確認してから送信した。実チェーンの後続2ブロックを待たずとも、その確定をノードは取り込んだ。

## SDK とノードの差・限界

- 正常系のスクリプト評価は SDK とノードで一致した。手数料0がノードに受理されるのは本検証の明示的なゼロ手数料設定下での結果。
- SDK `Spend.validate` は UTXO の未使用状態やmempool競合を検査しない。同一入力に対する確定・奪還はそれぞれ単独では true、ノードでは先に受理・採掘された方だけが成立する。祖先奪還の優先権までは保証しない。
- 浮遊ヘッダについては SDK とノードに差はない。双方受理する。コードはヘッダ内部のPoW・リンク・Merkle・時刻を検査するが、ノード自身の採用チェーンへの所属は参照しない。ノード実行でも実ブロック待機の保証に昇格しない。
- PoWが容易なregtestでの機能検証であり、公開網での攻撃コスト・手数料・既定ポリシー・最終性は測っていない。

## 再実行

Docker daemon と既存の `authority/node_modules` が必要。初回は公式イメージを取得する。

```bash
heavy docker pull --platform linux/amd64 bitcoinsv/bitcoin-sv@sha256:d96fe4786a00e5fc10bc9e0e76a6006376f9472d4eb74d07e4c1e0d019493d33
heavy bash authority/regtest/run.sh
```

`results.json` は再実行の観測結果で置換される。期待した拒否が成立しなければ終了コード2（現状は浮遊ヘッダ受理のため2）、実行途中の異常は別の非ゼロ終了となる。成功終了を装わない。

## 変更・検証

追加は `authority/regtest/run.sh`、`verify.mjs`、`results.json` と本書のみ。既存未追跡の `authority/lib/cov/intent.mjs`・`script.mjs.baktest` は変更・commitしない。構文チェックと使い捨てコンテナによる再実行を実施。終了後に検証コンテナが残っていないことを確認した。
