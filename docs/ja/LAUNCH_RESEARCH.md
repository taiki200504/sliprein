# ローンチ調査: 1体だけ止められるゲートウェイ

調査日: 2026-11-16。読んだ計画は `docs/LAUNCH_PLAN.md`。製品の説明は `docs/explainer/index.html`。投稿、パッケージ登録、commit はしていない。

## 結論

無名のセキュリティ用リポジトリが、作成週に1000スターを取った例は、今回測った範囲に無い。初週の実測は、一番きれいな起動でも snyk/agent-scan の182（残スターの下限）だった。Cisco の MCP Scanner は Hacker News で168点を取った日に216増えて、その後は約1.1kで頭打ちに近い。1000/7日は、NVIDIA、OpenAI による買収、中国語圏の既存ゲートウェイ、無料の多プロバイダ実用ツール、のどれかを伴った後の伸びで起きている。作成週が0のまま、数か月後に跳ねた例が複数ある。

「1つの鍵を止めて、他は生かす」は、LiteLLM / Bifrost / new-api / Portkey / OmniRoute の仮想キーが既にやる。語の leash は strongdm/leash（599）と npm の `leashed` が先に使っている。こちらの差は、エージェント自身が残数を分け、子の合計は親を超えられず、範囲は広げられず、1枝を止めると未使用分が親に戻る、という保存則である。その差は、今日のツリーでは npx 一行にも30秒 GIF にもなっていない。`gateway/package.json` は `"private": true` で bin が無く、ルート README は日本語で本番利用不可、商品化の推奨を撤回、テスト20件と書いている。計画にある131件と p99 は、この調査では測っていない。

名前は `oneleash`、`sliprein`、`branchhalt` が、非スコープの npm と GitHub の同名検索で空きに見えた。`leash` は使わない。Show HN の前に、英語 README、30秒の実デモ、既定インストールから BSV を外す、の3つが先である。スター目標は内部の数字に留め、投稿文には書かない。

## 測り方

スターは 2026-11-16 に `GET /repos/{owner}/{repo}/stargazers/history` で取った。週ごとの「その日に付いて、今も残っているスター」である。外したスターは記録されないので、下限である。初週は、作成日を含む UTC 7日。個人の stargazer 一覧は、認証しても 404 になるため使っていない。

README の見出しは、同日に raw.githubusercontent.com の README から取った。デモの「GIF がある」は、OmniRoute など一部は本文中の語（gif / screenshot / npx 等）の検出であり、画像ファイルは開いていない。

## 1. 2025〜2026年にスターが伸びた10件

セキュリティ、ガードレール、プロキシに寄せ、かつ2025年以降にまとまった増加があるものを10件にした。ゲートウェイの巨大リポジトリは、セキュリティ製品ではないものも含めた。それを隠すと、何がスターを動かしたかの判断を誤る。

| # | リポジトリ | 作成 | 残スター下限 | 初週 | 2025年増 | 2026年増 |
|---|---|---|---|---:|---:|---:|
| 1 | [cheaper-inference/OmniRoute](https://github.com/cheaper-inference/OmniRoute) | 2026-02-13 | 87954 | 14 | — | 87954 |
| 2 | [BerriAI/litellm](https://github.com/BerriAI/litellm) | 2023-07-27 | 63340 | 120（2023） | 17449 | 30968 |
| 3 | [QuantumNous/new-api](https://github.com/QuantumNous/new-api) | 2023-11-10 | 約52008 | 39（2023） | 9820 | 38119 |
| 4 | [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | 2023-04-28 | 27294 | 38（2023） | 4585 | 17812 |
| 5 | [NVIDIA/SkillSpector](https://github.com/NVIDIA/SkillSpector) | 2026-03-21 | 約26355 | 0 | — | 約26355 |
| 6 | [humanlayer/humanlayer](https://github.com/humanlayer/humanlayer) | 2024-08-05 | 12894 | 3（2024） | 7609 | 4830 |
| 7 | [maximhq/bifrost](https://github.com/maximhq/bifrost) | 2025-03-19 | 9579 | 0 | 1424 | 8155 |
| 8 | [agentgateway/agentgateway](https://github.com/agentgateway/agentgateway) | 2025-03-18 | 6215 | 0 | 1477 | 4738 |
| 9 | [snyk/agent-scan](https://github.com/snyk/agent-scan) | 2025-04-07 | 3242 | 182 | 1341 | 1901 |
| 10 | [cisco-ai-defense/mcp-scanner](https://github.com/cisco-ai-defense/mcp-scanner) | 2025-09-24 | 1119 | 5 | 10月27日に216 | 年次は未分割 |

### 1. OmniRoute

- 見出し: `# 🚀 OmniRoute — The Free AI Gateway`。作者は Diego Souza（diegosouzapw）。
- デモ: README 本文に gif、screenshot、demo、dashboard、docker、npx、curl、video の語がある。サイトは https://omniroute.online 。画像ファイルは未開封。
- 初週は14。急増は2026-07-19から07-26。残スターの日次は 07-19: 1245、07-20: 1841、07-21: 1623、07-22: 1775、07-23: 1800、07-24: 1483、07-26: 1105。07-19起算の7日で10762。08-05 も1091。
- 最初に話題になった投稿の URL は、HN と Reddit を探して特定できなかった。2026-10-18 付けとされるスター依頼の議論は、2026-11-16 の `is:discussion` 再検索では0件だった。7月の急増の原因としては書かない。大きいのは実用の無料ゲートウェイであり、セキュリティ製品ではない。

### 2. LiteLLM

- GitHub の説明は "The fastest, litest AI Gateway." README の最初の見出しは `## What is LiteLLM`（H1 の前にバッジ）。
- デモ: docker、curl、ダッシュボード。
- 2026年の増加は、嬉しいローンチと重なっていない。PyPI 汚染の告知が前面に出た。
  - https://news.ycombinator.com/item?id=47501426 「Tell HN: Litellm 1.82.7 and 1.82.8 on PyPI are compromised」938点、2026-03-24。関連 issue は https://github.com/BerriAI/litellm/issues/24512
  - https://news.ycombinator.com/item?id=47501729 739点
  - https://news.ycombinator.com/item?id=50181114 596点、2026-10-21、1.107.0
- 03-24起算の7日で1540。日次の山は03-25: 453。告知の週と重なる。
- 仮想キーは管理者がマスターキーで `POST /key/generate` する。予算の正本は https://docs.litellm.ai/docs/proxy/users （ページ日付 2026-11-16）。チーム予算は共有プール（`team_id` を付けるとチームの共有予算から引く）。DB 無しの `max_budget` はフェイルオープンで、上限を超えてもリクエストが通る、と同一ページに書かれている。

### 3. new-api

- 見出しは `New API`。太字の一行は "An AI gateway for models, applications, and agents"。
- デモ: スクリーンショット、docker compose（New API + Postgres + Redis）、Web コンソール。README 末尾にスター依頼がある。
- One API（songquanpeng/one-api、MIT）の AGPL フォークで、中国語圏のセルフホスト多プロバイダ向け。最初の話題 URL は1本に定まらなかった。linux.do や v2ex は推測であり、この調査では開いていない。
- 増えたのは既存需要とスター依頼であり、ガードレールの新規性ではない。管理者が発行するキーとクォータであり、エージェントが残数を分割する保存則ではない。

### 4. promptfoo

- 見出し: `Promptfoo: LLM evals & red teaming`。冒頭の引用で、OpenAI の一部になり MIT のまま、と書いてある。
- デモ: README に GIF と npx。
- 2026年の伸びは買収と重なる。
  - https://news.ycombinator.com/item?id=47312346 「Promptfoo Is Joining OpenAI」28点、2026-03-09。ブログ https://www.promptfoo.dev/blog/promptfoo-joining-openai/
  - https://news.ycombinator.com/item?id=47311833 OpenAI 側の投稿
- 元の Show HN は https://news.ycombinator.com/item?id=35807020 （typpo/promptfoo、14点、2023-05-03）。03-09起算の7日で5497。日次の山は03-12: 1372、03-13: 1297。買収ニュースでスターが動く型であり、このリポジトリが再現できる型ではない。

### 5. SkillSpector

- 見出し: `SkillSpector`。リードは "Security scanner for AI agent skills. Detect vulnerabilities, malicious patterns, and security risks before installing agent skills."
- デモ: CLI。`uv tool install` のあと `skillspector scan ... --no-llm`。任意で MCP ツール `scan_skill`。GIF 主導のローンチではない。
- 初週は0。2026-06-12は780。山は06-13: 922、06-14: 981、06-15: 927。06-11起算の7日で5328。2026-10-26 も821。
- 最初の公開発火は HN。https://news.ycombinator.com/item?id=48509844 「SkillSpector」49点、2026-06-12。当日が780で、翌日が922。
- Reddit は副次。
  - https://www.reddit.com/r/blueteamsec/comments/1tsnfpf/ （2026-05-31、薄い）
  - https://www.reddit.com/r/mcp/comments/1u5xgpe/ （2026-06-14、フィルタで削除）
  - https://www.reddit.com/r/mcp/comments/1w734yf/ （2026-09-04）
  - https://www.reddit.com/r/BestGitHubRepos/comments/1xidfad/ （2026-10-29、約22008スター時点で README を引用）
  - https://www.reddit.com/r/claudeskills/comments/1xrhmua/ （2026-11-08。静的スキャンが SKILL.md の「ユーザーに言うな」を見逃した、という利用者の報告）
- 動いたのは NVIDIA のブランドと、スキルを入れる怖さである。2026-11-15〜16の X 上の言及は、その後の会話であり、起点ではない。

### 6. HumanLayer

- 着火は窓の直前。https://news.ycombinator.com/item?id=42247368 「Launch HN: Human Layer (YC F24) – Human-in-the-Loop API for AI Systems」354点、2024-11-26。初週（2024-08）は3。
- 2025〜26年で一番大きい7日は2025-09-25起算の2379。ピーク日は09-27の856。時期が重なるのは https://news.ycombinator.com/item?id=45347532 「Getting AI to work in complex codebases」517点、2025-09-23、リンク先は github.com/humanlayer。承認APIのローンチではなく、複雑なコードベースでエージェントを使う書き物が前面に出た週である。
- 2026-11-16 時点の README は別物になっている。見出し `HumanLayer`。リードは、Claude Code / Codex / OpenCode / Pi を自分のマシンで走らせ、チームが1か所から操縦する、という制御プレーン。デモの語は docker。
- その後の HN。
  - https://news.ycombinator.com/item?id=50215925 「HumanLayer is now Open Source」31点、2026-10-23。ブログ https://www.hlyr.dev/blog/open-sourcing-humanlayer
  - https://news.ycombinator.com/item?id=50369245 「Factory Acquires HumanLayer」6点、2026-11-04。https://factory.com/news/humanlayer
- 2024年の「1アクションを人が承認して止める」に一番近い。2025〜26年のスターと現在の README は、コーディングエージェントの制御プレーンである。今の製品が回数券のリードと同じ、とは書かない。

### 7. Bifrost

- 見出し: `Bifrost AI Gateway`。続く見出しは `## The fastest way to build AI applications that never go down`。Go、Apache-2.0。5k RPS で200µs 未満、は彼らの主張であり、この調査では測っていない。
- デモ: `npx -y @maximhq/bifrost`、docker、Web UI `localhost:8080`、curl、Postman ボタン。サイト https://getmaxim.ai/llm-gateway 。
- HN は動かしていない。
  - Show HN https://news.ycombinator.com/item?id=46203228 3点、2025-12-09
  - https://news.ycombinator.com/item?id=46196561 5点、2025-12-08
  - 「Bitfrost」https://news.ycombinator.com/item?id=44820784 8点、2025-08-07
- メンテナの Reddit。
  - https://www.reddit.com/r/mcp/comments/1r19i1q/ （2026-02-10）
  - https://www.reddit.com/r/mcp/comments/1rehql0/ （2026-02-25。仮想キーで、エージェントに見せる MCP ツールを絞る。保存された回数の分割ではない）
- 仮想キーの正本は https://docs.getbifrost.ai/features/governance/virtual-keys 。独立した予算で、チームや顧客の予算と一緒に検査される。Budget Override は、基準の予算を変えずに支出枠を一時的に足す。階層の課金は https://docs.getbifrost.ai/enterprise/teams-business-units-customers 。キー、チーム、所属する顧客の上限をすべて通す。分けた整数が保存される形ではない。
- r/msp の2026-05-08に別製品の "Bifrost" がある。maximhq/bifrost とは別物。

### 8. agentgateway

- リード: "The first complete connectivity solution for Agentic AI." 見出しに "Intro to Agentgateway Video"。Rust、Apache-2.0、Linux Foundation。
- デモ: 紹介動画と、バイナリ / Kubernetes。1つのプロキシで、OpenAI 互換の LLM、MCP、A2A、JWT / API キー / OAuth、CEL の RBAC、レート制限、ガードレール、予算。
- 初週は0。最初の大きい一次資料は HN ではなくプレスリリース。https://www.prnewswire.com/news-releases/linux-foundation-welcomes-agentgateway-project-to-accelerate-ai-agent-adoption-while-maintaining-security-observability-and-governance-302534106.html （2025-08-25）。リポジトリは https://github.com/agentgateway/agentgateway 。2026-06-04 に AAIF 参加（Solo.io のブログ）。自分たちの Show HN は、検索の上位に出てこなかった。

### 9. agent-scan（旧 mcp-scan）

- 旧名 invariantlabs-ai/mcp-scan は snyk/agent-scan に転送される。見出しは `Snyk Agent Scan`。見出しの中身は CLI 出力の見本（v0.5.x と v0.6+）。
- デモ: CLI の写し。最初は `uvx mcp-scan@latest`、のちに `npx mcp-scan@latest`。プロキシモードがある。ドキュメント https://invariantlabs-ai.github.io/docs/mcp-scan/
- 初週182。内訳は 04-10: 33、04-11: 96、04-12: 32、04-13: 21。この10件で、作成週が一番大きい。それでも182であり、1000ではない。
- 起点は、既に回っていた事故の10日後のスキャナである。
  - 攻撃の告知: https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks （2025-04-01）。4月11日の更新でスキャナを指している。
  - 公開: https://invariantlabs.ai/blog/introducing-mcp-scan （2025-04-11）
  - X: https://x.com/marc_r_fischer/status/1915438704648245467 （2025-04-24、「500 stars を超えた」、いいね10）
- 遅い HN は弱い。https://news.ycombinator.com/item?id=46916390 3点、2026-02-06。

### 10. MCP Scanner（Cisco）

- 見出し: `MCP Scanner`。リードは "A Python tool for scanning MCP (Model Context Protocol) servers and tools for potential security findings"（Cisco AI Defense の inspect API、YARA、LLM）。
- デモ: README に gif、demo、docker、uvx の語。
- 初週は5。山は2025-10-27: 216、10-28: 138、10-24: 53。
- 原因は HN の同日。https://news.ycombinator.com/item?id=45723699 「MCP-Scanner – Scan MCP Servers for vulnerabilities」168点、2025-10-27。10-24起算の7日で495。フロントページの168点が、1000スター/週にはなっていない。

### 10件に入れなかったが、型の比較に使うもの

- huggingface/safeagents。286、作成2026-10-28、初週68。README は "A lightweight local proxy between your agent and its model server." 導入は `curl | sh`。`base_url` を向け、ツール呼び出しを止める。デモの形は計画に近い。伸びていない。YouTube は https://www.youtube.com/watch?v=GoG2-SSSU5k （Better Stack、2026-11-15、約7千再生）。
- NVIDIA/garak。10047、作成2023-05-10、初週0。山は窓の前で、2024-11-17: 352、11-18: 464、11-19: 241。HN https://news.ycombinator.com/item?id=42163591 「Garak, LLM Vulnerability Scanner」211点、2024-11-17。2025年は3426、2026年は3484の定常。見出しは "garak, LLM vulnerability scanner" / "Generative AI Red-teaming & Assessment Kit"。
- stacklok/toolhive。2342、作成2025-03-12、初週0。最大の日でも47（2026-09-07）。見出しは MCP サーバを隔離コンテナで即時に走らせる、というもの。急増ではない。競合としては節2に置く。
- tensorzero/tensorzero。11701、作成2024-07-16、初週2。2025年8980、2026年1190のあとアーカイブ。https://news.ycombinator.com/item?id=48516504 279点、2026-06-13（資金調達のあとに突然アーカイブ）。フォークのスレ https://news.ycombinator.com/item?id=48524250 。元の Show HN https://news.ycombinator.com/item?id=41557020 49点、2024-09-16。信頼を落とすとスレが立つ、という教訓。
- Portkey-AI/gateway。13388、作成2023-08-23、初週2。2025年3541、2026年3386。Show HN https://news.ycombinator.com/item?id=41246643 21点（2024-08-14）、https://news.ycombinator.com/item?id=38911677 37点（2024-01-08）。仮想キーがある。
- strongdm/leash。599、作成2025-10-21、初週11。最大の日は2026-02-03の39。急増ではない。名前と製品がかぶるので節2と節3に置く。
- LlamaFirewall（2025-04-29、meta-llama/PurpleLlama の中）の HN https://news.ycombinator.com/item?id=43840247 は1点。PurpleLlama の2025年増は1165、2026年は577。初週236は2023年。ローンチがスターを動かさなかった例。

## 共通して効いた要素

1. 読者が既に使っている道具へ、その日に1コマンドで入る。事故の告知が既に回っていると強い。mcp-scan は4月1日の攻撃、4月11日のスキャナ、初週182。Cisco は HN の当日に216で止まり、その後は伸びが細い。SkillSpector の6月中旬と OmniRoute の7月中旬は大きいが、無名のセキュリティリポジトリの作成週ではない。
2. 新しいフレームワークを配らず、Claude Code / Cursor / Codex / MCP の設定に差し込む。OmniRoute、Bifrost、safeagents、agentgateway、toolhive、leash がこれを先頭に置いている。巨大なスター数は、セキュリティの長文ではなく実用ゲートウェイについている。
3. 「安全」という形容を置かず、比べられる数字か、名前の付いた攻撃を置く。Bifrost のレイテンシ主張は HN を取っていない（3〜8点）。リポジトリ自体は2026年に約8k増えている。SkillSpector の拡声器は NVIDIA である。
4. 最初の画面に出力が見える。CLI の写し（mcp-scan、SkillSpector、garak）、curl と手元の Web UI（Bifrost、new-api、OmniRoute）。解説動画だけでは safeagents は初週68、その後286で止まっている。
5. 届ける経路が、アイデアより強い。Linux Foundation のプレス（agentgateway）、NVIDIA（SkillSpector）、OpenAI による買収（promptfoo）、中国語圏のセルフホスト需要と README のスター依頼（new-api）、無料の多プロバイダ（OmniRoute）。Bifrost、agentgateway、SkillSpector の作成週は0である。

計画の「7日で1000スター」は、内部の目標として置ける。投稿に書く数字ではない。このリポジトリには、上の5つのうち「ブランド、買収、既存需要、スター依頼」がまだ無い。残るのは、1コマンドと、最初の画面の出力である。両方とも未出荷である。

## 2. 近い競合と、保存則との差

既にある。差を「止められる」と書くと、HN では既存製品の列挙で終わる。

### 仮想キーで、1本を止めて他は生かす

LiteLLM、Bifrost、new-api、Portkey、OmniRoute。管理者がキーを発行し、予算・モデル・回転数を付け、そのキーだけを無効にする。他のキーは生きる。説明ページ（`docs/explainer/index.html`）も、社内なら人ごとの API キーと管理画面で大半が足りる、と既に書いている。

足りない部分は次のとおり。

- エージェント自身が、自分の残数を子に渡す。子の合計は親以下で、範囲は狭めることしかできない。ダッシュボードの希望ではなく、分割の時点で構造としてそうなる。
- 1人の子を止めたとき、使っていない分が親に戻り、二重に数えない。
- 子が別会社でも、呼び出しがこのゲートウェイを通る限り同じ規則になる。

Bifrost の階層は、顧客、チーム、仮想キーがそれぞれ独立した上限を持ち、全部を通過する。Override は枠を足す（https://docs.getbifrost.ai/features/governance/virtual-keys）。LiteLLM のチーム予算は共有プールで、キーを無効にしても「確保していた残数」は返らない。確保が無い（https://docs.litellm.ai/docs/proxy/users）。

### 1回の呼び出しや、1回の実行を止める

huggingface/safeagents、cisco mcp-scanner、snyk/agent-scan のプロキシモード、NeMo、Guardrails AI、Superagent、LlamaFirewall、HumanLayer の承認、LangGraph の interrupt、OpenAI Agents SDK の tripwire、Claude Code の hooks。これらは1回を止めるか、1回の走行を止める。木の上で回数が保存され、未使用分が親に戻る、というものではない。

### コンテナとポリシーで、エージェントを閉じ込める

strongdm/leash。https://github.com/strongdm/leash 。599、Apache-2.0、作成2025-10-21。README の意味は "Leash wraps AI coding agents in containers and monitors their activity. You define policies in Cedar; Leash enforces them instantly." 導入は `npm install -g @strongdm/leash`、起動は `leash --open claude`、UI は localhost:18080。ブログ https://www.strongdm.com/blog/policy-enforcement-for-agentic-ai-with-leash （2025-10-29）。サイト https://leash.strongdm.ai/ 。サンドボックスと Cedar であり、保存された回数の木ではない。比喩は先に取られている。

npm `leashed@0.2.0` は取得済み。説明は "AI got hands. This is the leash. Policy, audit, kill switch..."。リポジトリは dormstern/leashed（12、作成2026-02-19）。`npx leashed yank` がキルスイッチとして存在する。小さいが、比喩は使用中である。

stacklok/toolhive は MCP サーバを隔離し、リクエスト単位のポリシーを任意で付ける。急増はしていない。

### 権限を委譲して狭めるトークン

Macaroons、Biscuit（https://www.biscuitsec.org/）、UCAN（https://ucan.xyz/）は、権限の減衰と委譲を既に定義している。OpenAI 互換の回数ゲートウェイで、部分木の未使用分を親に戻す製品ではない。コンピュータサイエンスの先行であり、スター履歴はこの調査の対象外である。

### この製品が先に言うべき境界

- 会社をまたぐ、は、呼び出しがこのゲートウェイを通る場合に限る。子会社が自分のプロバイダ鍵を持っていれば、迂回できる。
- 数を数える主体はゲートウェイの運営者である。settle の前に、運営者は数をごまかせる。既定はトラストレスではない。
- 停止は、このプロキシを次に通った呼び出しへの 403 である。既に通した呼び出しの副作用は戻らない。プロキシを通らないシェル、決済、MCP 呼び出しは止まらない。
- 説明ページが書いている p99 0.6〜0.9ms は、彼らの測定である。この調査では再実行していない。

## 3. 名前

2026-11-16 に確認した。npm は `https://registry.npmjs.org/<name>` の非スコープ名。GitHub は `in:name` の完全一致（`oneleash` 等は total_count まで見た）、`/{name}` のユーザー、`/{name}/{name}` のリポジトリ。有名とは、スターが数百以上か、開発者が既に知っている製品名。スコープ付き（`@org/name`）は総当たりしていない。登録はしていない。`npm init` の直前に、同じ検索をやり直す。404 は翌日に埋まる。

### 候補10

| 名前 | npm 非スコープ | GitHub | 判定 |
|---|---|---|---|
| oneleash | 404 | 検索 total 0。ユーザー無し。`oneleash/oneleash` 404 | 空きに見える。短い候補では一番覚えやすい |
| sliprein | 404 | 検索 total 0。ユーザー無し。`sliprein/sliprein` 404 | 空きに見える。語として一番きれい |
| branchhalt | 404 | 検索 total 0。ユーザー無し | 空きに見える。覚えやすさは落ちる |
| leadline | 404 | ユーザー `leadline` がいる。有名リポジトリは無い。cloudflare-apps/LeadLine は5。Nazim22/leadline（2）はコーディングエージェントの根拠ルータ | 有名ではない。エージェント隣接の小さい衝突がある |
| faregate | 404 | 組織 `faregate` がいる。有名リポジトリは無い。matttproud/faregate は3。LSO-AI/faregate はクローラ課金で0 | 有名ではない。組織名は取られている |
| deadstop | 404 | ユーザー `DEADStop`。superNGA/DeadStop は0。完全一致は検索上1件 | 有名ではない。空きではない |
| estop | 404 | 組織 `EStop` と `EStop/estop`（0）。完全一致が検索の先頭100件だけで20件超。全部0〜1スター | 有名な製品リポジトリは無い。語は産業用の緊急停止として既に混んでいる |
| shortleash | 404 | 組織 `ShortLeash`。calasdan-sketch/shortleash（0）の説明が、AI コーディングエージェントのサーキットブレーカ | npm は空。意味は先に使われている。使わない |
| leash | 1.0.0 取得済み（中身は無関係な MongoDB のサービスハンドラ） | strongdm/leash 599。組織 `Leash`。他に jcubic/leash 124、melihmucuk/leash 48 | 使わない |
| halter | 2.5.7 取得済み（Web のルータ） | 組織 `halter`。Itzsten/Halter は14で、マルウェアの教材。有名ではない | npm が埋まっている。使わない |

`oneleash` を第一候補にする。`sliprein` は衝突が一番少ない。`branchhalt` は保険。3つとも、取得操作はこの調査ではしていない。

### 同日に見て、候補から外した語

| 語 | 結果 |
|---|---|
| agentleash | npm `agentleash@1.0.1` 「AgentLeash CLI - AI Agent Access Control」。GitHub ユーザーは無い。同名リポジトリは0〜1スターが複数。npm の repository 欄は skygkruger/scopeagent を指している |
| leashed | npm `leashed@0.2.0`。組織 `Leashed`。dormstern/leashed 12。キルスイッチの説明がそのまま製品 |
| turnstile | npm `turnstile@5.0.5`。nuxt-modules/turnstile 296（Cloudflare Turnstile）。chimera-linux/turnstile 202。Cloudflare の製品名とかぶる |
| collar | npm `collar@0.0.0` で名前は占有。組織 `Collar`。検索上位10件に完全一致の有名リポジトリは無かった |
| rein | npm `rein@0.1.5`。ユーザー `Rein`。検索上位に完全一致の有名リポジトリは無かった。npm で止まる |
| bridle | npm `bridle@1.0.2`。neiii/bridle 444（エージェント用ハーネスの設定マネージャ） |
| tether | npm `tether@3.0.2`。shipshapecode/tether 8483 |
| ripcord | npm `ripcord@4.0.0`。検索上位の完全一致は小さい。Ripcord は Discord クライアントとして知られている |
| yank | npm `yank@0.0.1`。mptre/yank 1717。`npx leashed yank` が動詞としても使われている |
| curb | npm `curb@1.0.1`。taf2/curb 1333（Ruby の libcurl） |
| gateline | npm `gateline@0.0.0` 「Every PR walks the gateline. Reserved.」。ユーザー `gateline`。nathancrtr/gateline は1 |

前回の完全一致検索は、レスポンスの扱いミスで途中停止した。上の表は、そのあと取り直した2026-11-16の結果である。

## 4. LAUNCH_PLAN の弱点と、HN で先に来そうな点

計画の「投稿は下書きのまま、本人が押す」は残す。それ以外で、公開前に直すものがある。

- 7日で1000スター、外部 issue 20、導入報告5、は観測レンジの外に目標を置いている。作成週が0だったもの（Bifrost、agentgateway、SkillSpector）と、初週182の mcp-scan と、HN 168点で216スターの Cisco が、近い比較である。OmniRoute の作成週も14で、跳ねたのは5か月後である。
- 「導入は npx 一行」は、今日のツリーにはまだ無い。`gateway/package.json` は private、bin 無し、パッケージ名無し、engines は node 24 以上。スクリプトは test / demo / demo:bsv だけ。
- 30秒 GIF（3体、2体目だけ止める、他は続く）は無い。あるのは `docs/explainer/index.html` の日本語クリック玩具で、消費は乱数である。
- 計画の131テストと p99 1ms 未満は、この調査では数えていない。ルート README（2026-11-13）はテスト20件、本番利用不可、商品化の推奨を撤回、デモはメモリ上の Ed25519、と書いている。公開 README と計画が、別の製品を説明している。
- 見出しから BSV を隠しても、`authority/` と `@bsv` が既定のツリーに残る。HN はそこを読む。
- スターを動かした実例は、ブランド、買収、既存需要、明示的なスター依頼である。このリポジトリには、そのどれもまだ無い。
- 自前のレッドチームは、外部の監査ではない。
- 2週目の Product Hunt は、デモが実物になったあとの第二報にはなる。デモが玩具のままの修正にはならない。
- コピーの "leash" は、strongdm がエージェントのセキュリティで先に使っている。機構が違っても、スレの最初の返信は「strongdm のがある」になる。

### HN で来そうな5点と、先に置く答え

1. 「LiteLLM / Bifrost / new-api / Portkey / OmniRoute が、1本のキーを止めて他を生かす。strongdm/leash と leashed が、リードとキルスイッチを既に売っている。」
   そのとおり、と最初に書く。管理者が発行したキーを1本止めることと、サンドボックスのキルスイッチは既にある。新しく見せるのは、エージェントが自分の残数を分け、子の合計が親を超えられず、範囲を広げられず、1枝を止めると未使用分が戻ることである。「1体止められる」も「leash という言葉」も、新規だとは書かない。説明ページの対比表を、英語 README の先頭に置く。

2. 「ゲートウェイを信じる必要がある。これはカウンタだ。」
   最初の画面で同意する。API を運営している主体が、数も数える。渡された束を、運営者が水増しすることはできない。既定モードはトラストレスではない。BSV は任意の研究アダプタであり、既定のインストールには入れない。今日のツリーは、まだそうなっていない。

3. 「シェルも決済も、ここを通らない MCP も止まらない。通してしまった呼び出しは戻せない。」
   1行目に書く。403 は、このプロキシの次の呼び出しだけである。副作用が脅威なら、leash 型のサンドボックスと組む、と書く。

4. 「p99 1ms 未満も、4回壊した、も自前測定だ。1ms は負荷をかけたプロキシ全体ではなく、sqlite の検査かもしれない。Bifrost はベンチを公開している。公開 README はテスト20件で、計画は131件だ。」
   ハーネス、機材、同時実行数を公開し、認可検査の時間とエンドツーエンドを分ける。レッドチームの文書は、通った攻撃も含めてリンクする。「安全」とは書かない。131件と 0.6ms は、テストを数え直し、ベンチをやり直し、そのコマンドを README に置くまで、投稿に出さない。この調査では両方とも未実行である。

5. 「リポジトリは日本語の研究断り書きと BSV で、利用者はゼロだ。Bifrost の初週は0、mcp-scan は182、safeagents は68。Cisco の168点は216スターだった。」
   現状を先に認める。ルート README は本番利用不可と、商品化推奨の撤回を書いている。ゲートウェイのパッケージは private で bin が無い。BSV は `authority/` にあり、読者は見つける。Show HN の前に、既定インストールが `@bsv` を import しないこと、英語 README がリードのデモから始まること、投稿に「本番利用者はいない」と書くこと。スター目標は投稿に出さない。

## 5. 題名と、1投稿目

題名も投稿も英語のまま置く。送信はしていない。GIF はまだ無い。投稿文は、3体の実画面が撮れてから押す前提である。投稿は人が行う。

### Show HN の題名

1. Show HN: Stop one AI agent without revoking the API key the others use
2. Show HN: A proxy where an agent can split a call budget it cannot increase
3. Show HN: Revoke one branch of delegated agent calls and leave the siblings running
4. Show HN: Call quotas that sub-agents can re-delegate but not inflate
5. Show HN: One 403 for the runaway agent; the other agents keep their remaining calls

最上位は1か4。1は読者の現状（鍵を消すと全員死ぬ）から入る。4は機構（分けられるが増やせない）から入る。最上級も "fully safe" も BSV も入れていない。

### X の1投稿目

1.

Three agents share one API key. I stopped the middle one. The other two kept getting 200s.

The stopped branch gets a 403 on its next call. Unused calls go back to the parent. Siblings keep what they have left.

2.

An agent can hand part of its remaining calls to a child. The children cannot add up to more than the parent, and they cannot widen what the parent allowed.

Stop one branch. The unused slice comes back. The others keep running.

3.

Revoking the API key stops every agent on it. This proxy returns 403 for one branch on the next call through it.

The process that counts is trusted. A shell command, a payment, or an MCP call that never hit the proxy keeps going. A call that already went through is not undone.

1を最初に出す。GIF か端末の連続ショットを、文の直前に付ける。2は機構を聞かれた日の単体投稿。3は「で、何が止まらないの」に先に答える投稿で、信頼を落とす文を自分から置いている。スターの依頼、価格、保証、トラストレス、BSV は、3本とも入れていない。

## このファイルを書くときにやらなかったこと

- commit、push、Issue、Discussion、スター、npm publish、GitHub の組織作成、HN / X / Reddit への送信。
- テスト件数の再集計と、p99 の再測定。計画の131件と 0.6ms は、未確認のまま「未確認」と書いた。
- `docs/PRACTICAL_V1_RESULT.md` と `gateway/README.md` は、作業ディレクトリの違いで一度「無い」と返り、絶対パスでの再確認はしていない。数値の根拠には使っていない。
- OmniRoute の7月急増を説明する1本の投稿 URL。探して、特定できなかった。
- new-api の最初のフォーラム URL。特定できなかった。
- スコープ付き npm（`@someone/oneleash` 等）の総当たり。
