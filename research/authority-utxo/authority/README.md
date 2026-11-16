# Authority UTXO 試作（v0.4）

設計: [docs/AUTHORITY_UTXO.md](../../../docs/ja/AUTHORITY_UTXO.md)。ローカル研究試作で、本番利用・新規性・安全性は未実証。

## 実行

```sh
cd authority
nice -n 15 node --test --test-concurrency=1 authority.test.mjs covenant.test.mjs redteam.test.mjs redteam2.test.mjs v04.test.mjs
```

Node 24 / @bsv/sdk。秘密鍵はテスト中のみ生成。ネットワーク接続・実資金・送信・ブロードキャストはない。

## スクリプト自身が強制する規則

`lib/cov/` は OP_PUSH_TX で sighash preimage を実取引に束縛し、`Spend.validate()` だけで判定する。取引組立関数での検査をスクリプト検証の代わりにはしない。

- 状態は114バイト: holder33 / R32 / n4 / P4 / T4 / d4 / phase1 / intent32。n・P・T・d はスクリプトでも `0 ≤ x < 2^31` と4バイトの正規表現を検査する。
- ANNOUNCE は idle から announcing へ移し、枠・操作集合・期限・祖先列・深さ・satoshi を変えない。保有者の署名が必要。
- intent は確定出力列の Bitcoin 直列化の二重SHA256（hashOutputs）。出力順・satoshi・状態・コード・破棄出力も含む。確定時はこのハッシュと既存の保存則・縮小則の両方を検査する。
- CONFIRM は announcing だけから可能。preimage outpoint の txid（内部バイト順）を h0 の Merkle 根へ結ぶ。Merkle 証明は最大8段、空の sibling は未使用。index の残りは0を強制する。
- h0〜hK の80バイトヘッダK+1本で、各二重SHA256の値を符号なしLE数として発行時ターゲットと比較し、隣接 prevhash の一致を検査する。K=2 は h0 の後の2本を意味する。
- 期限は `hK.time ≤ T`。nLockTime / nSequence / 旧 U は遅延や期限の根拠にしない。nLockTime は OP_PUSH_TX の低S署名を作るために最大400回動かす。
- 使用確定は枠を1減らす。委任確定は子2個の枠合計≤親、子P⊆親、子T≤親、祖先列の拡張、深さ≤8、破棄枠の明示を強制する。
- RECLAIM は idle / announcing の両方で遅延なし。祖先署名とハッシュ連鎖の接頭辞を検証し、同じ残枠・P・Tを祖先へ戻す。兄弟枝は消費しない。
- 全パスは単一入力、署名型ALL|FORKID、同じコード型、satoshi合計保存を強制する。

API: `spendAnnounceUse` / `spendAnnounceDelegate` → 戻り値の `outputs[0]` に対して `spendConfirmUse` / `spendConfirmDelegate`。確認用の `headers` と `merkleProof: {siblings: Buffer[], index}` を渡す。低水準 `spendAnnounce` は任意の32バイトintentを受けるが、不正な意図は確定時の保存則等を通らない。旧名 `spendUse` / `spendDelegate` は確定のみで、idle の直接使用を拒否する。`announceAndConfirm` と `headers.mjs` の採掘はテスト用。

## 残る信頼と未対応

省略時の既定ターゲットはテスト専用 `2^240−1`（平均約65536試行/ヘッダ）。`nBits` の申告値では難易度を決めない。本番難易度に相当せず、攻撃者はこの低い作業量を払って偽ヘッダを作れる。

検証するのはヘッダ内の包含と作業量であり、ヘッダの実チェーン所属・最長鎖・正しい現在時刻ではない。攻撃者が取引を秘匿して先に採掘することや、偽ヘッダに古い時刻を入れることも防がない。したがって実時間の失効期限、祖先が気づく猶予、祖先の必勝は保証しない。祖先の監視、合意・採掘コスト・鍵管理・実装の正しさへの依存が残る。

手数料入力・手数料控除、回収先UTXOとの合算、2-of-3祖先鍵、8段超のMerkle証明、複数権限入力、外部APIの一回実行、実ノード/コンセンサスでの評価、形式検証、秘匿性は未対応。CLIのローカルSDK検証だけでノードの受理を保証しない。

`authority.test.mjs` の従来13件はv0.1の検証関数・メモリ台帳の回帰であり、v0.3のコベナントとは別。v0.3の保存則・縮小則・奪還は `covenant.test.mjs`、反例拒否・生の不正状態・ヘッダ証明は `redteam.test.mjs` で検証する。かつてのnLockTimeによる遅延保証は撤回した。

スクリプトサイズ・最終検証結果は下記の検証記録に記載する。

## 検証記録（2026-11-16）

ローカルSDK評価: 73件成功 / 失敗0 / skip0（従来13 + covenant30 + redteam30）。上記の直列実行で15.3秒。ロックスクリプトは全状態共通3,237バイト（状態114バイトを含む）。実ノード検証・独立レビュー・CIはこの作業では未実施。

## v0.4 発行パラメータと継承

`makeUtxo({state, params: {K: 73, target: 0x225459n << 168n}})` または `covLockingScript(state, params)` で発行する。target は正の256ビットbigint、Kは整数1〜512。例のtargetは bits `0x18225459` を展開した値（高さ975655の資料値で、現在値とは限らない）。省略時は互換テスト用の K=2 / target=2^240−1。targetが大きいほど易しい。

Kとtargetは状態やunlocking引数ではなくコード部に固定する。全出力はpreimageから取り出した親のコード部を使って直列化され、hashOutputsと一致しなければ拒否される。予告・使用・委任の子・奪還出力のすべてで継承する。paramsメタデータは組立補助であり、検証の権威はロックスクリプト。K=512の大きなスクリプト用にCompactSizeの5バイト長にも対応した。

試験は2系統。既存73件と他の正常系は易しいターゲット。redteam2のR2-AとR2-Eはメインネット相当targetで発行し、易しい浮遊ヘッダによる確定を拒否し、祖先の奪還は受理する。メインネット難易度の正例はローカルで採掘不能のため作らない。この拒否は浮遊ヘッダ全般の拒否を意味しない。同じtargetを満たす自作ヘッダは依然通り得る。

K選定の設計目安は `K+1 ≥ V ÷ (1ブロック報酬の時価)`。Vは守る価値。資料値の3.125 BSV×14.484748 USDなら1万USDに対しK≈220（K=73は約3,350USD相当であり、設計文書の1万USD例は計算が合わない）。価格・難易度・費用は変動する。この式は機会費用の目安であって攻撃費の下限保証やBSV確認安全性との厳密な同値証明ではない。難易度を1/4に緩めるならtargetを4倍し、同じ目安を保つにはK+1も4倍必要。

### v0.4 検証記録（2026-11-16）

既存73 + redteam2 11 + v04 7 = 91件成功、失敗0、skip0、21.353秒。詳細・最終結果は [v0.4検証記録](../../../docs/ja/AUTHORITY_UTXO_V04_RESULT_2026-11-16.md)。測定は `Spend.validate()` 呼出しだけ（採掘・スクリプト生成・署名・組立時間を除外）、nice15・単一直列・このMacの1試行で、性能保証ではない。

易しいtarget=2^255−1で使用確定に成功した測定: K=2は3,243バイト / 2.519ms、K=73は13,921バイト / 3.822ms。状態114バイトを含むロックスクリプトのサイズ。ヘッダだけのサイズはK=73で74×80=5,920バイト。固定幅33バイトでtargetをコードに格納するため、メインネット相当targetでもロックスクリプトのサイズは同じ。K=512の発行・予告・使用確定・奪還もSDKで確認する。
