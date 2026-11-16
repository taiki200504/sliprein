# Authority UTXO v0.4 実装結果

Task: 1116-authority-utxo / Agent: codex

## 完了と強制規則

HEAD a098f3c / origin/feat/authority-utxo を確認し、`git pull --ff-only origin feat/authority-utxo` 成功後に着手した。既存未追跡intent.mjsとscript.mjs.baktestは保持し、追加委譲していない。

発行API `makeUtxo({state, params: {K, target}})` / `covLockingScript(state, params)`。Kは整数1〜512、targetは1〜2^256−1のbigint。既定は互換試験用K=2 / 2^240−1。K+1個の80バイトヘッダをコード生成時に展開し、各作業量・隣接prevhash・最終時刻・h0内の予告txid包含をSpend.validateで検査する。targetは符号なし33バイトのScript数値へ変換してコード部へ埋め込む。

親preimageのscriptCodeからコード部tailを取り出し、各後継出力に連結してhashOutputsと比較する既存の規則により、予告・使用残り・委任の両子・奪還も同じKとtargetになる。パラメータを弱めた子出力を先に予告しても、確認時hashOutputsで拒否する。奪還の改変も同じ検査で拒否した。paramsメタデータは組立用に継承するだけで、スクリプトが検証の権威。K=512で65,535バイトを超えるため、CompactSize 5バイトをpreimage読出しとintent直列化に対応した。

保存則・縮小則・祖先接頭辞・単一入力・ALL|FORKID・OP_PUSH_TX・数値の符号と範囲の既存検査を保持した。

## テストと測定

初回v04試験は4件中3件失敗（不正発行パラメータ、大きいKのサイズ、奪還時パラメータ弱化）。実装後に通過。R2-A/R2-Eはメインネット相当targetで発行する拒否試験へ変更した。他の正常系は易しいtargetを使う。

実行はauthorityディレクトリで `nice -n 15 node --test --test-concurrency=1 authority.test.mjs covenant.test.mjs redteam.test.mjs redteam2.test.mjs v04.test.mjs`。@bsv/sdk Spend.validateのみ、ノード・実資金・送信なし。既存73件 + redteam2 11件 + v04 7件 = 91件。最終実行は91件成功・失敗0・skip0、21.353秒。git diff --check成功。

- bits 0x18225459を展開したtarget（0x225459 << 168）を発行時に固定。R2-Aの易しい浮遊ヘッダ、R2-Eの確定側はheaders:workで拒否。R2-Eの祖先奪還は成功。メインネット難易度の正例はローカル採掘不能のため不要として未実行。
- K=1/2/73の使用確定と継承、K=73のヘッダ不足・連結改変拒否、K=512の発行・予告・使用確定・奪還、不正K/targetの発行拒否、委任/奪還によるパラメータ弱化拒否を確認する。
- K=2: locking script 3,243バイト、Spend.validate 2.519ms。K=73: 13,921バイト、3.822ms。v04単体実行時の1試行、target=2^255−1で使用確定に成功した値。状態114バイトを含み、採掘・生成・署名・組立は時間から除外。パラメータtargetは33バイト固定幅なのでメインネット相当でもサイズは同じ。K=73のヘッダ自体は5,920バイト。

## K選定と残る信頼

設計式 `K+1 ≥ V ÷ (1ブロック報酬の時価)` は機会費用換算の目安。資料値3.125 BSV×14.484748 USDなら1ブロック約45.265USD。V=1万USDならK=220以上（221ブロック分）。設計文書の「K≈73で1万USD」は不整合で、K=73は約3,350USD。元の仕様文書は変更せず、この差分を明記した。難易度1/4ならtargetを4倍し、同じ目安にはK+1も4倍する。Kの上限512を超える価値・難易度緩和はこの実装範囲外。

同じtargetを満たす浮遊ヘッダは依然有効。実チェーン所属・最長鎖・正しい現在時刻・取引公開は検証しない。攻撃者による秘匿採掘・古い時刻、ハッシュパワー調達費と報酬の差、難易度や価格の変化を解消しない。従ってBSVのK確認と厳密に同じ安全性、実時間の窓、祖先必勝、ドル建ての攻撃費下限は実証していない。祖先の監視、合意・採掘費用・鍵管理・SDK/スクリプトの正しさ、サービスの確定後実行に依存する。

## 未対応と変更範囲

手数料入力/控除、回収UTXO合算、しきい値祖先鍵、8段超Merkle、複数権限入力、外部APIの一回実行、秘匿、形式検証、実ノード/ポリシー受理、本番安全性、新規性は未対応/未実証。追加委譲禁止により独立レビューなし。PR・マージなし。

変更: README.md、authority/README.md、authority/package.json、authority/lib/cov/{script,spend,headers,index}.mjs、authority/redteam2.test.mjs、authority/v04.test.mjs、本書。AI_WORKLOG.mdはローカル記帳でコミットしない。
