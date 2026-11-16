# AIの許可範囲と実行の検査 — 学習用基準

2026-11-13改訂。従来αは既知の署名・認可検査を理解する学習用基準であり、新規性は未実証。「革新への十分な一歩」「商品化を推奨する成果」という位置づけと従来の商品推奨を撤回する。研究の目的・比較対象・中止基準は [研究課題](RESEARCH_QUESTION.md) を正本とする。


架空の社内記録 `record.patch` をメモリ内で更新する。Node標準cryptoのEd25519を使用し、外部依存・ネットワークなし。承認用と結果用の鍵は分離し、CLIでメモリ内生成する。秘密鍵は表示しない。

```sh
node demo.mjs
node --test --test-concurrency=1 demo.test.mjs
```

CLIは記録更新・結果検証、結果改変拒否、replay拒否をJSONで出力する。状態は `{record:{tenant,id,status,revision}}`、入力は `{expectedRevision,status}`。statusはdraft/reviewedのみ。期待revision一致時だけ新しいstateを生成する。

承認はapprovalId/tenant/actor/tool/resource/argsDigest/expiresAt/nonce/policyVersionへ署名する。検証鍵は呼出側の固定trust/envから受け取り、bundleの任意鍵を拒否する。現在context・allowedTools・policy版・期限・失効IDと照合し、古いread承認を現在のwrite権限で広げない。期限は `0 < expiresAt-now <= 300000ms`（ちょうど5分は許可、期限ちょうどは拒否）。発行時刻や実際の承認年齢は証明しない。

固定の平坦schema、文字列最大128文字、安全整数、引数の限定値を検査する。キーsortによる限定JSONでありRFC 8785準拠ではない。オブジェクト入力を対象とし、生JSONストリームのサイズ制限や重複キー検出は実装しない。

`verifyReceipt(receipt, expectedApproval, trust)` は外部固定の承認鍵・結果鍵を使い、期待する署名済み承認と結果のdigest・主体・対象・入力・版の対応を検査する。署名者が現実の副作用や記録の真実を証明するものではない。検証は過去receiptの整合性確認であり、現在の権限・失効・時刻で再認可する関数ではない。

消費Set・失効Setは同一プロセスのみ。本人認証/OAuth/実API/永続replay/並行処理/意味保証/TEE/チェーンはない。信頼する呼出側と通常の可変メモリを前提にし、敵対的Proxyや改造されたSet等は対象外。

CI実測 (historical CI run 43380448908)（検証SHA: `d9c31f75e6f847a56bf4633395d022d2111a4251`、2026-11-13）でNode 24のテスト20件成功・失敗0件、CLI成功を確認。ローカルNode実行・テスト・ビルドは未実行。test-firstで作成したが実測REDはない。親担当から独立レビューP1/P2なしとの報告あり。これは歴史的な学習用基準の動作確認であり、新しい研究課題の達成や本番安全性を示さない。本番利用不可。

この20件は固定メモリデモの回帰テストであり、改訂前の広い20シナリオ（旧計画。現在は研究目的を変更）全ての達成を意味しない。今後の計画・未実施範囲は [research question](RESEARCH_QUESTION.md)。テーマA選択後、本人の修正依頼を受けて研究目的を変更。本番利用・価格・営業は未承認。

CIで取得した起動時の3行（そのまま）:

```json
{"event":"record.updated","state":{"record":{"tenant":"fictional-team","id":"demo","status":"reviewed","revision":2}},"receiptVerified":true}
{"event":"tampering","rejected":true}
{"event":"replay","rejected":true,"state":{"record":{"tenant":"fictional-team","id":"demo","status":"reviewed","revision":2}}}
```

Authority UTXO v0.4 のローカル検証（発行時K/ターゲット固定・予告・作業量証明・祖先奪還）は [authority/README.md](../../research/authority-utxo/authority/README.md)。本番利用不可。
