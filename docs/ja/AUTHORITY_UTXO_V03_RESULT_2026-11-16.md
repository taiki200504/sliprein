# Authority UTXO v0.3 実装結果

Task: 1116-authority-utxo / Agent: codex

## 完了

- `origin/feat/authority-utxo` の upstream を確認し `git pull --ff-only origin feat/authority-utxo` 成功後に着手。
- v0.2のOP_PUSH_TX / OP_SIZE 34 / 単一入力prologueを維持。状態114バイト、ヘッダ込みの分岐を実装。
- 予告・確定・奪還、確定の出力コミット、使用/委任の保存則と縮小則、h0内のoutpoint txidのMerkle証明、h0〜h2の連結と固定作業量、h2.time≤T、生のn/P/T/dの範囲検査。
- SDK `Spend.validate()` のみ。送信・PR・マージなし。

## 検証

実行: `heavy nice -n 15 node --test --test-concurrency=1 authority.test.mjs covenant.test.mjs redteam.test.mjs`（authorityディレクトリ）。

73件成功、失敗0、skip0、15.3秒。従来13件を保持、covenant30件をv0.3へ更新、redteam30件（旧X01〜X07/X22の拒否、4数値の符号境界、生状態、予告中奪還、ヘッダ不足/連結/作業量/別txid/意図/期限、2葉Merkle等）。`git diff --check` 成功。ロックスクリプト3,237バイト、状態114バイト。

最終差分は自分で確認。追加委譲禁止につき独立レビューなし。実ノード・実チェーン・CIは未検証。テスト先行の実測REDを全項目で記録してはいない。

## 設計上の選択と未対応

意図ハッシュは旧未追跡intent.mjsの個別フィールド連結ではなく、確定出力列のBitcoin直列化の二重SHA256（hashOutputs）を使った。コード・状態・値・出力順・破棄出力をすべて束縛し、スクリプト内で保存則と縮小則も別に検査する。

テストターゲット2^240−1、K=2。平均約65536試行/ヘッダの弱い作業量。実チェーン所属、最長鎖、壁時計の期限、取引公開、祖先が必ず勝つことは保証しない。秘匿採掘・古い時刻の偽ヘッダが可能。保護は偽ヘッダ作成コストへの依存である。

手数料、回収合算、しきい値祖先鍵、8段超Merkle、外部APIの一回実行、形式検証、実ノード受理、新規性・本番安全性は未対応/未実証。

## 変更ファイル

README.md / authority/README.md / authority/covenant.test.mjs / authority/redteam.test.mjs / authority/package.json / authority/lib/cov/index.mjs / authority/lib/cov/script.mjs / authority/lib/cov/spend.mjs / authority/lib/cov/headers.mjs / 本ファイル。

前任の未追跡 `intent.mjs` と `script.mjs.baktest` は変更せず、コミットしない。`headers.mjs` は前任ファイルを流用してコミットする。既存のtracked変更は開始時点でなかった。AI_WORKLOG.mdはローカル記帳のみ。
