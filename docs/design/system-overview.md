# システム設計概要

## 目的

Minecraft サーバーをプレイ時間のみ起動するコスト最適化アーキテクチャ。
プレイヤーが接続を試みた瞬間にゲームサーバーを自動起動し、
無人状態が 30 分継続したら自動停止する。

---

## コンポーネント一覧

| コンポーネント | 種別 | 役割 |
|--------------|------|------|
| プロキシ EC2 | t4g.nano (ARM) 常駐 | 接続受付・ゲームサーバー起動・TCP 転送 |
| ゲームサーバー EC2 | t3.large オンデマンド | Paper Minecraft 本体 |
| Lambda (auto-shutdown) | Python 3.12 | 無人検知・EC2 停止 |
| EventBridge Rule | 5 分間隔 | Lambda を定期トリガー |
| SSM Parameter Store | `/minecraft/last_player_seen` | プレイヤー最終確認時刻の受け渡し |
| Route 53 | ホストゾーン + A レコード | `minecraft.your-domain.com` → プロキシ EIP |

---

## アーキテクチャ図

```
[プレイヤー PC]
      │
      │ TCP 25565  (minecraft.your-domain.com)
      ▼
┌─────────────────────────────────────┐
│  プロキシ EC2 (t4g.nano)             │
│  Elastic IP (固定)                   │
│                                      │
│  mc-proxy.py (Python asyncio)        │
│  ┌───────────────────────────────┐   │
│  │ 1. Handshake パケット解析     │   │
│  │ 2. EC2 状態確認 (boto3)       │   │
│  │ 3a. running → TCP 双方向転送  │   │
│  │ 3b. stopped → StartInstances  │   │
│  │      → MOTD/Disconnect 返却   │   │
│  └───────────────────────────────┘   │
└──────────────┬──────────────────────┘
               │ プライベート IP: TCP 25565
               │ StartInstances API (IAM Role)
               ▼
┌─────────────────────────────────────┐
│  ゲームサーバー EC2 (t3.large)       │
│  ※ プレイ時間のみ起動               │
│                                      │
│  ┌───────────────────────────┐       │
│  │ Paper 1.21.11 (systemd)   │       │
│  │ TCP 25565                 │       │
│  └───────────────────────────┘       │
│  ┌───────────────────────────┐       │
│  │ player-monitor.py         │       │
│  │ (systemd timer: 5分おき)   │       │
│  │ Query Protocol (UDP)      │       │
│  │ → SSM PutParameter        │       │
│  └───────────────────────────┘       │
│  ┌───────────────────────────┐       │
│  │ EBS gp3 20GB              │       │
│  │ (DeleteOnTermination=OFF) │       │
│  └───────────────────────────┘       │
└─────────────────────────────────────┘

[SSM Parameter Store]
  /minecraft/last_player_seen
  (プレイヤーあり時の Unix タイムスタンプ)
         ▲ PutParameter              │ GetParameter
         │ (player-monitor.py)       │ (Lambda)
         │                           ▼
[EventBridge Rule: 5分おき] → [Lambda: auto-shutdown]
                                     │ StopInstances (30分不在時)
                                     ▼
                              [ゲームサーバー EC2]

[Route 53]
  your-domain.com  ホストゾーン
  minecraft.your-domain.com → A レコード → プロキシ EIP
```

---

## データフロー

### 接続フロー (ゲームサーバー停止中)

```
1. プレイヤーが minecraft.your-domain.com:25565 へ接続
2. DNS: Route 53 A レコード → プロキシ EIP に解決
3. プロキシ: Minecraft Handshake パケットを受信・解析
4. プロキシ: boto3 でゲームサーバー EC2 の状態を確認 → "stopped"
5. プロキシ: ec2.start_instances() を呼び出し
6. プロキシ: プレイヤーに MOTD / Disconnect を返す ("起動中...")
7. (1〜2 分後) EC2 が running に遷移
8. (さらに 30〜90 秒) Minecraft プロセスが起動
9. プレイヤーが再接続 → プロキシが TCP 転送へ移行
```

### 接続フロー (ゲームサーバー起動中)

```
1. プレイヤーが接続
2. プロキシ: EC2 状態確認 → "running"
3. プロキシ: ゲームサーバーへの TCP 接続を試みる (5秒タイムアウト)
   ├── 成功: asyncio で双方向 TCP パイプを確立 → 透過転送
   └── 失敗 (Minecraft 起動中): MOTD "起動中..." を返す
```

### 自動停止フロー

```
1. EventBridge Rule が 5 分おきに Lambda を呼び出す
2. Lambda: EC2 状態確認 → running でなければ終了
3. Lambda: LaunchTime を確認 → 起動後 30 分未満ならスキップ
4. Lambda: SSM /minecraft/last_player_seen を取得
   └── 存在しない: 現在時刻で初期化して終了
5. Lambda: (現在時刻 - last_player_seen) >= 30分 → StopInstances 呼び出し
```

### プレイヤー監視フロー (ゲームサーバー上)

```
1. systemd timer が 5 分おきに player-monitor.py を実行
2. Minecraft Query Protocol (UDP localhost:25565) でプレイヤー数を取得
3. プレイヤー数 > 0: SSM /minecraft/last_player_seen を現在時刻で更新
4. プレイヤー数 = 0: SSM は更新しない (タイムアウトが進行)
```

---

## EC2 ライフサイクル

```
[stopped] ←─────────── StopInstances (Lambda)
    │
    │ StartInstances (mc-proxy.py)
    ▼
[pending]
    │ ~30-60 秒
    ▼
[running] ──── systemd: minecraft.service 自動起動
    │           systemd: player-monitor.timer 起動済み
    │
    │ (プレイヤー接続可能)
    │
    │ 30分間プレイヤー不在
    ▼
[stopping] → [stopped]
```

---

## ファイル構成

```
minecraft_server/
├── docs/
│   ├── requirements.md              # 要件定義書
│   └── design/
│       ├── system-overview.md       # このファイル: システム概要
│       ├── proxy.md                 # mc-proxy.py 設計詳細
│       ├── auto-shutdown.md         # 自動停止機構の設計
│       └── infrastructure.md        # CDK / AWS リソース設計
└── cdk/
    ├── bin/minecraft-server.ts      # CDK App エントリポイント
    ├── lib/
    │   ├── security-group-stack.ts  # SG (プロキシ用・ゲーム用)
    │   ├── proxy-stack.ts           # プロキシ EC2 + EIP
    │   ├── game-server-stack.ts     # ゲームサーバー EC2 + EBS
    │   ├── monitoring-stack.ts      # Lambda + EventBridge
    │   └── dns-stack.ts             # Route 53
    ├── scripts/
    │   ├── mc-proxy.py              # プロキシスクリプト (プロキシ EC2 上)
    │   └── player-monitor.py        # プレイヤー監視 (ゲームサーバー上)
    └── lambda/
        └── auto-shutdown/
            └── index.py             # 自動停止 Lambda
```
