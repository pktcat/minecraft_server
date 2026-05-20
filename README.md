# Minecraft Server on AWS

Minecraft Java Edition サーバーのウェイクオンデマンド構成。
プレイヤーが接続したときだけゲームサーバーを自動起動し、30 分無人が続いたら自動停止する。

## アーキテクチャ

```
[プレイヤー] ──TCP 25565──► [プロキシ EC2 (t4g.nano, 常駐)]
                                     │
                          停止中なら StartInstances
                                     │
                                     ▼
                           [ゲームサーバー EC2 (t3.large, オンデマンド)]
                            Paper 1.21.11 / EBS 20GB gp3

[EventBridge 5分おき] ──► [Lambda] ──30分無人──► StopInstances
                                │
                         [SSM Parameter Store]
                          /minecraft/last_player_seen
```

- **プロキシ**: Python asyncio で実装した Minecraft Java Edition プロトコル対応プロキシ。ゲームサーバーが停止中の場合は `StartInstances` を呼び出し、起動中の旨を MOTD / Disconnect で返す。
- **プレイヤー監視**: ゲームサーバー上の systemd timer が 5 分おきに Minecraft Query Protocol (UDP) でプレイヤー数を取得し、SSM Parameter Store に最終在席時刻を書き込む。
- **自動停止**: Lambda が 5 分おきに SSM を参照し、30 分以上不在なら `StopInstances` を呼ぶ。

## ファイル構成

```
minecraft_server/
├── docs/
│   ├── requirements.md          # 要件定義書
│   └── design/
│       ├── system-overview.md   # システム設計概要
│       ├── proxy.md             # mc-proxy.py 設計詳細
│       ├── auto-shutdown.md     # 自動停止設計詳細
│       └── infrastructure.md   # CDK / AWS リソース設計
└── cdk/
    ├── bin/minecraft-server.ts  # CDK App エントリポイント
    ├── lib/
    │   ├── security-group-stack.ts  # SG (プロキシ用・ゲーム用)
    │   ├── proxy-stack.ts           # プロキシ EC2 + EIP
    │   ├── game-server-stack.ts     # ゲームサーバー EC2 + EBS
    │   ├── monitoring-stack.ts      # Lambda + EventBridge
    │   └── dns-stack.ts             # Route 53
    ├── scripts/
    │   ├── mc-proxy.py          # プロキシスクリプト
    │   └── player-monitor.py    # プレイヤー監視スクリプト
    └── lambda/
        └── auto-shutdown/
            └── index.py         # 自動停止 Lambda
```

## 月額コスト (参考)

| リソース | 月額 |
|---------|------|
| プロキシ EC2 (t4g.nano, 常駐) | ~$3.7 |
| ゲームサーバー EBS 20GB gp3 | ~$1.6 |
| Elastic IP | $0 (EC2 稼働中) |
| Route 53 ホストゾーン | $0.5 |
| Lambda / SSM / S3 | ~$0 |
| **固定費合計** | **~$6/月** |
| ゲームサーバー EC2 (t3.large) | $0.104/h × プレイ時間 |

## デプロイ

### 前提条件

- Node.js 18+
- AWS CDK v2 (`npm install -g aws-cdk`)
- AWS CLI (デプロイ先アカウントの認証情報を設定済み)

### 手順

```bash
cd cdk
npm install
npm run build

# 初回のみ
cdk bootstrap

# デプロイ (全スタック)
cdk deploy --all
```

### スタック構成と依存関係

```
MinecraftSgStack
  └── MinecraftGameStack
        ├── MinecraftProxyStack
        │     └── MinecraftDnsStack
        └── MinecraftMonitorStack
```

デプロイ順序は CDK が自動解決する。

### デプロイ後の確認

1. `MinecraftDnsStack` の Output に表示される NS レコードをドメイン登録に設定する
2. SSM Session Manager でプロキシ EC2 に接続し `mc-proxy.service` の起動を確認する
3. Minecraft クライアントから接続し、自動起動・プロキシ動作を確認する

## 運用

### EC2 への接続 (SSM Session Manager)

```bash
# プロキシ EC2
aws ssm start-session --target <proxy-instance-id> --region ap-northeast-1

# ゲームサーバー EC2 (running 状態のみ接続可)
aws ssm start-session --target <game-instance-id> --region ap-northeast-1
```

SSH キーペア不要。IAM 権限のみで接続できる。

### グレースピリオドと停止閾値の変更

`cdk/lambda/auto-shutdown/index.py` の定数を編集して `cdk deploy MinecraftMonitorStack` を実行する。

```python
GRACE_PERIOD_SEC       = 30 * 60  # 起動後この時間はシャットダウンしない
SHUTDOWN_THRESHOLD_SEC = 30 * 60  # 不在がこの時間続いたら停止
```

## 注意事項

- `cdk/cdk.context.json` には AWS アカウント ID が含まれるため `.gitignore` で除外している。`cdk synth` 実行時に自動再生成される。
- ゲームサーバーの EBS は `DeleteOnTermination: false` のため、EC2 を terminate してもデータは残る。
- Minecraft の jar・ワールドデータは EBS に保存されており、EC2 の停止・再起動では消えない。
