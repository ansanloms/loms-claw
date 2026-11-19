# 利用規約に関する注意

本プロジェクトは Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` の `query()`) を使用して Discord から Claude を呼び出す。利用にあたっては次の規約上の点を理解しておく必要がある。

最終確認日: 2026-11-19（次の引用は、この日に各ページの実物と照合したもの）。文言・解釈は変わりうるため、定期的に各ページの変更有無を確認し、確認したらこの日付を更新すること。

## 認証の仕組み

本プロジェクト自身は Claude の資格情報を読み書きしない。認証はサブスクリプション購入者本人がコンテナ内で `claude auth login`（Anthropic 自身のサインインフロー）を実行して行う。資格情報は `CLAUDE_CONFIG_DIR`（`/data/home`）に置かれ、`query()` が起動する SDK 同梱の無改変 Claude Code バイナリがそれを直接読む。コード中に OAuth トークンや API キーを扱う箇所は無い。

## サブスクリプションプランでの Agent SDK 利用

[Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) は、サブスクリプションプランで Agent SDK を使った場合の扱いを説明している。記事冒頭には 2 つの更新告知がある。

> Update October 7, 2026: Claude Max, Ultra, and Team plans now include monthly API credits. They cover the Claude API, Claude Managed Agents, and the Claude Agent SDK and `claude -p` when you run them with an API key from your linked Claude Console organization. Nothing changes for your plan: when you're signed in with your Claude plan, the Claude Agent SDK and `claude -p` still draw from your subscription limits.

> Update June 15, 2026: We've paused the previously-announced changes to Claude Agent SDK usage. For now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription limits.

現状は次のとおり。

- サブスクリプションでサインインした状態の Agent SDK の利用は、サブスクリプションの使用量上限（usage limits）から消費される。
- 2026-06-15 に一時停止された変更（Agent SDK の利用をサブスクリプションから切り離す変更）は、2026-11-19 時点で再開されていない。
- 2026-10-07 から、Max・Ultra・Team プランに月次の API クレジットが付く。対象は Console の API キーで Agent SDK 等を動かした場合で、サブスクリプション認証の利用には使われない。[Monthly API credits for Max, Ultra, and Team plans](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans) には次の記述がある。

  > Available on Max, Ultra, and Team plans, including discounted Team plans. Free, Pro, and Enterprise plans aren't eligible.

  > API credits cover `claude -p` and the Claude Agent SDK when you run them yourself with an API key.

本プロジェクトはこの状態のもとで Agent SDK をサブスクリプション認証により利用している。上記記事は今後も改定される可能性があるため、定期的に確認すること。

## 認証と資格情報の扱い

Claude Code ドキュメントの [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) にある「Authentication and credential use」節の現行の文言は次のとおり。

> **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.

> **Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

> Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under Can customers offer Claude Code in their products? above.

> Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

2 つ目の引用が禁止しているのは次の 3 つである。

- 第三者開発者が自分のアプリケーションに Claude.ai ログインを組み込んで提供すること
- ユーザーに代わって（on behalf of their users）Free/Pro/Max/Ultra プランの資格情報経由でリクエストを流すこと
- Claude.ai の資格情報・セッショントークンを収集・保管・仲介すること

本プロジェクトはサブスクリプション購入者本人がセルフホストする構成である。前節「認証の仕組み」のとおり、本プロジェクトは資格情報を扱わず、サインインは Anthropic 自身のフローで完了する。さらに `bot/guard.ts` の `isAuthorized()` が、設定された単一ギルド ID・単一ユーザー ID（本人）との完全一致を要求する。bot ユーザーと DM（ギルド外で `guildId` が一致しない）は拒否する。本人以外のリクエストが流れる構造になく、「他人のリクエストを代理で流す」形態には該当しない。なお bot 自身の投稿による起動（CLAUDE.md の「AI to AI 自己メンション」）は `isAuthorized()` を通らず `isAuthorizedSelfMessage()` で判定する。bot の投稿は本人のセッションまたは cron が同一ギルド内で生成したものに限られ、第三者のリクエストが流入する経路にはならない。この構造を崩さないこと。

一方で、同節は Agent SDK を使って製品・サービスを構築する開発者一般に API キー認証を求めている（2 つ目の引用の第 1 文）。本プロジェクトがサブスクリプション認証を使える根拠は、3 つ目の引用にある「無改変の Claude Code バイナリに本人のサブスクリプションでサインインする」形態に当たるという解釈だけである。本プロジェクトはそのバイナリを独自のシステムプロンプトと `canUseTool` で包んで動かしており、この形態に含まれると明示した文言は無い。4 つ目の引用のとおり、Anthropic は予告なく制限を執行しうる。解釈が外れた場合に備え、同ページの変更有無を定期的に確認すること。

## 自動実行の扱い

[Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms)（Effective: Oct 8, 2025）の Section 3 は、"You may not access or use, or help another person to access or use, our Services in the following ways:" に続けて次を挙げる。

> Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise.

本プロジェクトの Discord bot と cron ジョブはサブスクリプション認証で動くため、API キー経由の除外には当たらない。適用除外の根拠になりうるのは「where we otherwise explicitly permit it」で、それに当たる記述は次の 2 つである。

- support 記事が、サブスクリプションでサインインした Agent SDK の利用を使用量上限からの消費として扱っていること（前節「サブスクリプションプランでの Agent SDK 利用」）
- Legal and compliance の「Acceptable use」節の次の一文

  > Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK.

どちらも、サブスクリプション認証による Agent SDK の利用を前提にした記述である。ただし bot や cron による無人実行を明示的に許可した文言ではない。この点は解釈に依存する。解釈に頼らずに済ませるには、cron を Console の API キー認証で動かす構成が取れる（API キー経由なら上記の除外に当たり、Max・Ultra・Team なら月次の API クレジットも使える）。

本プロジェクトは cron ジョブによる定期自動実行を含む。稼働環境の件数は内部 API `GET /cron` で確認する。2026-11-19 時点でリポジトリが追跡する恒久ジョブは 11 本である（稼働環境のみのジョブは含まない）。このほか `once: true` の 1 回限りジョブが随時追加され、実行後に自動削除される。`news-*` 6 本は 8:00 に同時起動させている（2026-08-23 に 10 分刻みへ分散したが、分散前の同時起動でも負荷集中は見られなかったため 2026-08-29 に戻した）。同時刻の並列実行が負荷集中になる場合は発火時刻を分散させる。自動実行の頻度・規模は、上記の「個人の通常利用（ordinary, individual usage）」の想定を外れない範囲に保つこと。

（経緯: 以前は OAuth トークンの他製品利用が規約で禁止されていたため `claude -p` を直接 spawn する構成を採っていた。その後、月次クレジット導入の告知を受けて Agent SDK の直接利用へ移行し、`claude -p` は使っていない。告知された変更自体は上記のとおり一時停止されているが、現行の support 記事も Agent SDK の利用がサブスクリプションの使用量上限から消費されることを明記している）

## アカウント共有の禁止

[Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms)（Effective: Oct 8, 2025）の Section 2 には次の一文がある。

> You may not share your Account login information, Anthropic API key, or Account credentials with anyone else.

Discord の指定ギルド・指定ユーザー（1 人）のみが操作できる設計により、1 つのサブスクリプションを複数人で共有する構造にはなっていない。

**他のユーザーがアクセスできない状態を維持すること。**
