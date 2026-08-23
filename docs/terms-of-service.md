# 利用規約に関する注意

本プロジェクトは Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` の `query()`) を使用して Discord から Claude を呼び出す。利用にあたっては以下の規約上の点を理解しておく必要がある。

最終確認日: 2026-08-23（以下の引用は、この日に各ページの実物と照合したもの）。文言・解釈は変わりうるため、定期的に各ページの変更有無を確認し、確認したらこの日付を更新すること。

## サブスクリプションプランでの Agent SDK 利用

[Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) は、サブスクリプションプラン（Pro / Max 等）へ Agent SDK 用の月次クレジットを付与する変更を告知していたが、この変更は 2026-06-15 に発効前のまま一時停止された。記事冒頭より:

> Update June 15: We're pausing the changes to Claude Agent SDK usage described below. For now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits. The previously announced monthly credit, which would have been available to eligible claimants in connection with these changes, isn't available.

現状は次のとおり。

- 月次クレジットは付与されない（記事本文の説明は参照用に残されているだけで、発効していない）。
- Agent SDK・`claude -p`・サードパーティアプリの利用は、従来どおりサブスクリプションの使用量上限（usage limits）から消費される。

本プロジェクトはこの状態のもとで Agent SDK をサブスクリプション認証により利用している。一時停止された変更は再開・改定される可能性があるため、上記記事の定期的な確認を推奨する。

あわせて Claude Code ドキュメントの [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) にある「Authentication and credential use」節も参照すること。現行の文言は次のとおり。

> **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.

> Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

> Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under Can customers offer Claude Code in their products? above.

2 つ目の引用が禁止しているのは、第三者開発者が自分のアプリケーションに Claude.ai ログインを組み込んで提供すること、ユーザーに代わって（on behalf of their users）Free / Pro / Max プランの資格情報経由でリクエストを流すこと、および他人の Claude.ai 資格情報・セッショントークンを収集・保管・仲介することである。本プロジェクトはサブスクリプション購入者本人がセルフホストする構成で、認証は購入者本人がコンテナ内で SDK 同梱の無改変 Claude Code バイナリに対して `claude auth login`（Anthropic 自身のサインインフロー）を実行して行い、資格情報は本人の `data/home` にのみ置かれる（他人の資格情報を扱わない）。さらに `bot/guard.ts` の `isAuthorized()` が設定された単一ギルド ID・単一ユーザー ID（本人）との完全一致を要求し、bot ユーザーおよび DM（ギルド外、`guildId` が一致しない）を拒否する。本人以外のリクエストが流れる構造になく、「他人のリクエストを代理で流す」形態には該当しない。なお bot 自身の投稿による起動（CLAUDE.md の「AI to AI 自己メンション」）は `isAuthorized()` を通らず `isAuthorizedSelfMessage()` で判定するが、bot の投稿は本人のセッションまたは cron が同一ギルド内で生成したものに限られ、第三者のリクエストが流入する経路にはならない。この構造を崩さないこと。

なお同節は、Agent SDK を含め Claude の機能と連携する製品・サービスを構築する開発者一般には API キー認証を求めている（2 つ目の引用の第 1 文）。本プロジェクトの利用は上記のとおり第三者への提供に当たらず、3 つ目の引用にある「無改変の Claude Code バイナリに本人のサブスクリプションでサインインする」形態に留まるという理解に基づくが、文言・解釈は変わりうるため、同ページの変更有無を定期的に確認すること。

また同ページの「Usage policy」節には次の一文がある。

> Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK.

本プロジェクトは cron ジョブによる定期自動実行を含む（2026-08-23 確認時点で、稼働環境の `data/workspace/cron/` に定常ジョブ 10 本。このほか `once: true` の一回限りジョブが随時追加され、実行後に自動削除される）。自動実行の頻度・規模は、この「個人の通常利用（ordinary, individual usage）」の想定を外れない範囲に保つこと。

（経緯: 以前は OAuth トークンの他製品利用が規約で禁止されていたため `claude -p` を直接 spawn する構成を採っていた。その後、月次クレジット導入の告知を受けて Agent SDK の直接利用へ移行した。告知された変更自体は上記のとおり一時停止されているが、現行の support 記事も Agent SDK・サードパーティアプリの利用がサブスクリプションの使用量上限から消費されることを明記している。）

## アカウント共有の禁止

[Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms)（Effective: October 8, 2025）より:

> You may not share your Account login information, Anthropic API key, or Account credentials with anyone else.

Discord の指定ギルド・指定ユーザー（1 人）のみが操作できる設計により、1 つのサブスクリプションを複数人で共有する構造にはなっていない。

**他のユーザーがアクセスできない状態を維持すること。**
