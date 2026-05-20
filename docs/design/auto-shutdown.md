# 自動停止機構の設計

## 概要

ゲームサーバーのプレイヤー不在を検知し、30 分継続したら EC2 を自動停止する。
Lambda を VPC に入れず、SSM Parameter Store を中継点として使うことで
NAT Gateway のコストを排除している。

---

## コンポーネント構成

```
[ゲームサーバー EC2]                    [Lambda]
  player-monitor.py                   auto-shutdown/index.py
  (systemd timer: 5分おき)            (EventBridge: 5分おき)
        │                                    │
        │ Query Protocol (UDP localhost)      │ GetParameter / PutParameter
        │ → プレイヤー数取得                  │
        │                                    │
        │ PutParameter (プレイヤーあり時)     ▼
        └──────────────────────────► SSM Parameter Store
                                     /minecraft/last_player_seen
                                     (Unix タイムスタンプ)
                                            │
                                     (30分以上前なら)
                                            │
                                            ▼
                                     ec2.stop_instances()
                                     [ゲームサーバー EC2]
```

---

## player-monitor.py

**ファイル**: [cdk/scripts/player-monitor.py](../../cdk/scripts/player-monitor.py)
**動作環境**: ゲームサーバー EC2 上の systemd timer

### 動作ロジック

```
1. Minecraft Query Protocol (UDP localhost:25565) で Full Stat を取得
2. "numplayers" フィールドを解析してプレイヤー数を取得
3. プレイヤー数 > 0
      → SSM PutParameter: /minecraft/last_player_seen = 現在の Unix タイムスタンプ
4. プレイヤー数 = 0
      → 何もしない (SSM の値を更新しないことで時刻が古くなっていく)
```

### Minecraft Query Protocol (UDP)

Minecraft の `enable-query=true` で有効になる UDP ベースの統計取得プロトコル。

**Handshake シーケンス:**

```
クライアント → サーバー: Magic(0xFEFD) + Type(0x09) + SessionID(4byte)
クライアント ← サーバー: Type(1) + SessionID(4) + ChallengeToken(文字列)
```

**Full Stat リクエスト:**

```
クライアント → サーバー: Magic(0xFEFD) + Type(0x00) + SessionID + PaddedToken + Padding(4byte 0x00)
クライアント ← サーバー: Full stat データ (numplayers を含む)
```

レスポンスのパース:
```
"numplayers\x00<count>\x00" の形式で埋め込まれている
例: "...numplayers\x003\x00maxplayers\x00..." → プレイヤー数 3
```

サーバーが応答しない場合 (Minecraft 未起動など) は 0 を返して正常終了する。

### systemd 設定

**player-monitor.service** (oneshot):
```ini
[Unit]
Description=Minecraft Player Monitor (oneshot)
After=minecraft.service

[Service]
Type=oneshot
User=ec2-user
ExecStart=/usr/bin/python3 /opt/player-monitor.py
Environment=AWS_DEFAULT_REGION=ap-northeast-1
```

**player-monitor.timer** (5分おき):
```ini
[Unit]
Description=Run Minecraft player monitor every 5 minutes

[Timer]
OnBootSec=90s          ← 起動後 90 秒後に初回実行
OnUnitActiveSec=5min   ← 以降 5 分おき

[Install]
WantedBy=timers.target
```

タイマーは EC2 起動時に自動スタートするが、`minecraft.service` が
起動していない場合は player-monitor.py が Query Protocol に失敗し、
プレイヤー数 0 として正常終了する (エラーにならない)。

---

## auto-shutdown Lambda

**ファイル**: [cdk/lambda/auto-shutdown/index.py](../../cdk/lambda/auto-shutdown/index.py)
**トリガー**: EventBridge Rule (rate: 5分)

### 停止判定ロジック

```
handler(event, context):
  │
  ├─ EC2 状態確認 (describe_instances)
  │    └─ "running" 以外 → return (何もしない)
  │
  ├─ グレースピリオド確認
  │    LaunchTime から現在までの経過時間 < 30分
  │    └─ return (起動直後はシャットダウンしない)
  │
  ├─ SSM GetParameter: /minecraft/last_player_seen
  │    └─ ParameterNotFound
  │         → PutParameter (現在時刻で初期化) → return
  │
  └─ 不在時間計算
       (現在時刻 - last_player_seen) >= 30分
       ├─ Yes → stop_instances() → return
       └─ No  → ログ出力して return
```

### タイムライン例

```
T+0:00  EC2 起動 (StartInstances)
T+0:00  グレースピリオド開始 (30分間はシャットダウン対象外)
T+0:05  Lambda 実行 → グレースピリオド中 → スキップ
T+0:10  Lambda 実行 → グレースピリオド中 → スキップ
...
T+0:30  グレースピリオド終了
T+0:35  Lambda 実行 → last_player_seen が未設定 → 現在時刻で初期化 → return
         (プレイヤーがゲームに入っていれば player-monitor が書き込み済み)
T+1:05  プレイヤーが全員ログアウト (last_player_seen の更新が止まる)
T+1:10  Lambda 実行 → 不在 5分 → 継続
T+1:35  Lambda 実行 → 不在 30分 → StopInstances 呼び出し
T+1:35  EC2 stopping → stopped
```

### グレースピリオドの目的

EC2 が起動した直後はプレイヤーがまだゲームに入っていない。
この間に Lambda が「プレイヤー不在 30 分」と誤判定して即停止しないよう、
LaunchTime から 30 分間はシャットダウンを行わない。

> `last_player_seen` ではなく `LaunchTime` を使う理由:
> `last_player_seen` は前回の起動時の値が残っている可能性があるため、
> EC2 の起動時刻を使うことで正確に判定できる。

---

## SSM Parameter Store

| 項目 | 内容 |
|------|------|
| パラメータ名 | `/minecraft/last_player_seen` |
| 型 | String |
| 値 | Unix タイムスタンプ (秒, 整数文字列) |
| 書き込み側 | player-monitor.py (ゲームサーバー EC2) |
| 読み取り側 | auto-shutdown Lambda |

**IAM 権限:**
- ゲームサーバー EC2 ロール: `ssm:PutParameter`, `ssm:GetParameter` → `/minecraft/*`
- Lambda ロール: `ssm:GetParameter`, `ssm:PutParameter` → `/minecraft/*`

---

## タイミング図

```
時刻  │ player-monitor.py  │ Lambda          │ SSM value
──────┼───────────────────┼─────────────────┼──────────────
+0:00 │                   │                 │ (未設定)
+0:05 │ 実行: 3人 → 更新   │ 実行: grace     │ T+0:05
+0:10 │ 実行: 3人 → 更新   │ 実行: grace     │ T+0:10
+0:30 │ 実行: 2人 → 更新   │ 実行: grace終了 │ T+0:30
+0:35 │ 実行: 2人 → 更新   │ 実行: 不在0分   │ T+0:35
+0:40 │ 実行: 0人 → 更新なし│ 実行: 不在5分   │ T+0:35 (不変)
+0:45 │ 実行: 0人 → 更新なし│ 実行: 不在10分  │ T+0:35
...
+1:05 │ 実行: 0人 → 更新なし│ 実行: 不在30分  │ T+0:35
      │                   │ → StopInstances │
```
