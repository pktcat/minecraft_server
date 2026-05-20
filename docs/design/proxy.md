# プロキシ設計 (mc-proxy.py)

**ファイル**: [cdk/scripts/mc-proxy.py](../../cdk/scripts/mc-proxy.py)
**動作環境**: プロキシ EC2 (t4g.nano) 上の systemd サービス

---

## 概要

Python asyncio で実装された Minecraft Java Edition のウェイクオンデマンドプロキシ。
TCP 25565 をリッスンし、ゲームサーバー EC2 の状態に応じて接続を制御する。

---

## 環境変数

| 変数名 | 必須 | デフォルト | 説明 |
|--------|------|-----------|------|
| `GAME_INSTANCE_ID` | ✅ | - | ゲームサーバー EC2 のインスタンス ID |
| `GAME_PORT` | | 25565 | ゲームサーバーの Minecraft ポート |
| `LISTEN_PORT` | | 25565 | プロキシがリッスンするポート |
| `AWS_DEFAULT_REGION` | | ap-northeast-1 | boto3 が使用するリージョン |

---

## 処理フロー

### 全体ステートマシン

```
新規 TCP 接続
      │
      ▼
 Handshake パケット受信 (タイムアウト: 10秒)
      │
      ▼
 パケット解析
  - パケット長 (VarInt)
  - パケット ID (0x00 = Handshake)
  - プロトコルバージョン (読み飛ばし)
  - サーバーアドレス (読み飛ばし)
  - サーバーポート (読み飛ばし)
  - next_state: 1=Status / 2=Login
      │
      ▼
 EC2 状態確認 (boto3, キャッシュ TTL: 5秒)
      │
      ├── "running" ────────────────────────────────────┐
      │                                                  │
      │   ゲームサーバーへ TCP 接続試行 (タイムアウト: 5秒)  │
      │         │                                        │
      │         ├── 成功 → 双方向 TCP パイプ確立 → 終了   │
      │         │                                        │
      │         └── 失敗 (ConnectionRefused/Timeout)     │
      │               state を "pending" として扱う       │
      │                                                  ▼
      ├── "stopped" → StartInstances 呼び出し      (フォールスルー)
      │               (クールダウン: 30秒)
      │
      └── "pending" / "stopping" / "pending"(フォールスルー)
                │
                ├── next_state == 1 (Status/サーバーリスト)
                │     └── Status Response を返す (MOTD + Ping/Pong エコー)
                │
                └── next_state == 2 (Login)
                      └── Login Disconnect を返す
```

---

## Minecraft Java Edition プロトコル

### パケット形式

```
┌──────────────────────────────────┐
│ Packet Length  (VarInt)          │ ← 以降のバイト数
│ Packet ID      (VarInt)          │
│ Data           (可変長)           │
└──────────────────────────────────┘
```

### VarInt エンコーディング

7ビット単位で下位から格納。最上位ビット (MSB) が 1 の場合は続きがある。

```python
# 例: 300 (0x12C) → [0xAC, 0x02]
# 300 = 0b 10 0101100
#  → 0b 0101100 = 0x2C → MSB=1 → 0xAC
#  → 0b 10      = 0x02 → MSB=0 → 0x02
```

### Handshake パケット (0x00, Handshake state)

```
Packet ID:       0x00
Protocol Ver:    VarInt  (例: 769 = 1.21.4)
Server Address:  String  (接続先ホスト名)
Server Port:     UShort  (2バイト big-endian)
Next State:      VarInt  (1=Status, 2=Login)
```

プロキシはこのパケットを受信・解析し、`next_state` を判定する。

### Status Response パケット (0x00, Status state)

```json
{
  "version": { "name": "起動中...", "protocol": 769 },
  "players": { "max": 0, "online": 0, "sample": [] },
  "description": { "text": "§eサーバー起動中...\n§71〜2分後に再接続してください" },
  "enforcesSecureChat": false
}
```

### Login Disconnect パケット (0x00, Login state)

```json
{ "text": "§eサーバーが起動しています。\n§71〜2分後に再接続してください。" }
```

---

## EC2 状態キャッシュ

AWS API の呼び出し回数を削減するため、5 秒間キャッシュする。

```python
_cache = { "state": None, "private_ip": None, "ts": 0 }
CACHE_TTL = 5  # 秒
```

boto3 呼び出しはブロッキングのため `ThreadPoolExecutor` + `run_in_executor` で非同期化している。

---

## StartInstances クールダウン

複数の接続が同時に来た場合に `StartInstances` が重複して呼ばれるのを防ぐ。
最後に StartInstances を呼んでから 30 秒間は再呼び出しをスキップする。

```python
START_COOLDOWN = 30  # 秒
```

---

## メッセージ一覧

| 状況 | next_state | 表示内容 |
|------|-----------|---------|
| EC2 停止中 | Status (1) | `§cサーバー停止中\n§e接続すると自動起動します` |
| EC2 起動中 | Status (1) | `§eサーバー起動中...\n§71〜2分後に再接続してください` |
| EC2 停止中 | Login (2) | `§eサーバーを起動しています。\n§71〜2分後に再接続してください。` |
| EC2 起動中 | Login (2) | `§eサーバーが起動しています。\n§71〜2分後に再接続してください。` |

`§e` = 黄色、`§c` = 赤、`§7` = グレー (Minecraft カラーコード)

---

## TCP 双方向パイプ

ゲームサーバーが running かつ接続可能な場合、asyncio で透過プロキシとして動作する。

```
クライアント ←──── pipe() ────── ゲームサーバー
クライアント ──── pipe() ──────► ゲームサーバー
```

- `reader.read(4096)` で受信し `writer.write()` で送信
- 一方が切断したら反対側も閉じる
- Handshake パケット (`raw`) を先にゲームサーバーへ送信してからパイプ確立

---

## systemd サービス設定

プロキシ EC2 の `/etc/systemd/system/mc-proxy.service` として登録される。

```ini
[Unit]
Description=Minecraft Wake-on-Demand Proxy
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/mc-proxy.py
Environment=GAME_INSTANCE_ID=<CDK が展開するインスタンス ID>
Environment=GAME_PORT=25565
Environment=LISTEN_PORT=25565
Environment=AWS_DEFAULT_REGION=ap-northeast-1
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

---

## エラーハンドリング

| エラー | 処理 |
|--------|------|
| Handshake タイムアウト (10秒) | 接続を閉じる |
| Handshake パケット ID が 0x00 以外 | 接続を閉じる |
| VarInt デコードエラー | 例外をキャッチして接続を閉じる |
| ゲームサーバーへの接続タイムアウト/拒否 | EC2 を "pending" として扱い MOTD 返却 |
| boto3 API エラー | 例外ログを出力し接続を閉じる |
