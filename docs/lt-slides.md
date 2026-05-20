---
marp: true
theme: default
paginate: true
style: |
  section {
    font-family: 'Hiragino Sans', 'Meiryo', sans-serif;
    font-size: 28px;
  }
  h1 { color: #2d6a2d; }
  h2 { color: #2d6a2d; }
  strong { color: #e07000; }
  code { background: #f0f0f0; padding: 2px 8px; border-radius: 4px; }
  pre { background: #1e1e1e; color: #d4d4d4; padding: 16px; border-radius: 8px; font-size: 0.75em; }
  table { font-size: 0.85em; }
---

# 使ってないのに $80/月 払ってた話

Minecraft サーバーを AWS CDK でコスト最適化した

---

## 自己紹介

友達と遊ぶ用に EC2 で Minecraft サーバーを運用してた

かなり良いインスタンスを常駐していたため、初月のコスト請求を見たら

<br>

# **$80**

<br>

---

## 原因は明らか

t3.large が **24時間365日** 動いてる

実際に遊んでる時間 → 1日2〜3時間くらい

<br>

**稼働率 ≈ 10% なのに費用は 100%**

手動で止めようとしても面倒で結局つけっぱなし

---

## やりたいこと

> 誰かが繋ごうとしたら起動して  
> 誰もいなくなったら止めたい

プレイヤーは普通に `minecraft.your-domain.com` に繋ぐだけ

止まっていても「起動中...」って出れば待てる

せっかくなので **CDK でインフラ全部コード化** もやる

---

## 全体構成

```
プレイヤー
  │ TCP 25565
  ▼
プロキシ EC2 (t4g.nano, 常駐)   ← 月 $3 くらい
  │
  ├─ EC2 停止中 → StartInstances → 「起動中...」を返す
  └─ EC2 起動中 → TCP をそのまま転送
        │
        ▼
  ゲームサーバー EC2 (t3.large, オンデマンド)
        │
        └─ 30分不在 → Lambda が自動停止
```

---

## CDK で 5 スタックに分割

- `MinecraftSgStack` — セキュリティグループ
- `MinecraftGameStack` — ゲームサーバー EC2
- `MinecraftProxyStack` — プロキシ EC2
- `MinecraftMonitorStack` — Lambda + EventBridge
- `MinecraftDnsStack` — Route 53

`cdk deploy --all` で一発構築

---

## プロキシ EC2 で動くもの

systemd サービスとして `mc-proxy.service` を常駐

```
mc-proxy.py (Python asyncio)
  ├── TCP 25565 で Listen
  ├── 接続ごとに asyncio タスクを生成
  ├── Minecraft Handshake パケットを読んで next_state を解析
  ├── next_state=1 (ping) → MOTD を返すだけ（EC2 は起動しない）
  └── next_state=2 (login)
        ├── EC2 stopped → boto3 で StartInstances → Disconnect 返却
        └── EC2 running  → ゲームサーバーへ TCP 転送
```

EC2 状態確認も `boto3` で同期せず `asyncio` の executor に投げてる

---

## Minecraft Java Edition プロトコル

TCP 接続直後に必ず **Handshake パケット**が来る

```
┌─────────────────────────────────────────────────────┐
│ Packet Length   (VarInt)                            │
│ Packet ID: 0x00 (VarInt)                            │
│ Protocol Version (VarInt)  e.g. 768 = 1.21.x       │
│ Server Address   (String)  "minecraft.your-domain.com" │
│ Server Port      (u16)     25565                    │
│ Next State       (VarInt)  1=Status  2=Login        │
└─────────────────────────────────────────────────────┘
```

**VarInt** は可変長整数（1〜5バイト）。最上位ビットが 1 なら続きがある

`next_state` だけ読めばプロキシの動作を分岐できる

---

## mc-proxy.py の中身（抜粋）

```python
async def handle_connection(reader, writer):
    # Handshake パケットを受信
    data = await reader.read(4096)
    next_state = parse_handshake(data)   # VarInt を手でパース

    ec2_state = get_ec2_state()          # boto3 で確認

    if next_state == 1:                  # Status ping
        writer.write(make_status_response(ec2_state))

    elif next_state == 2:                # Login
        if ec2_state == "stopped":
            await start_game_server()    # StartInstances
            # 起動中の Disconnect パケットを返す
            writer.write(make_disconnect("起動中です。1〜2分後に再接続してください"))
        else:
            # ゲームサーバーへ双方向 TCP 転送
            await pipe(reader, writer, GAME_SERVER_IP, 25565)
```

---

## ゲームサーバー EC2 で動くもの

systemd で **2つのユニット**を管理

```
minecraft.service      ← Paper Minecraft 本体
  ExecStart: java -Xms512M -Xmx6G \
    -XX:+UseG1GC -XX:+ParallelRefProcEnabled \  ← Aikar's Flags
    -jar paper-1.21.11-113.jar --nogui
  Restart=on-failure

player-monitor.service ← プレイヤー監視
  Type=oneshot
  ExecStart: /usr/bin/python3 /home/ec2-user/player-monitor.py

player-monitor.timer   ← 5分おきに上記を起動
  OnBootSec=3min
  OnUnitActiveSec=5min
```

---

## player-monitor.py: Query Protocol

Minecraft には **Query Protocol (UDP)** というサーバー状態取得の仕組みがある

```
1. UDP でハンドシェイク送信
   → 0xFE 0xFD 0x09 + sessionId (4bytes)

2. サーバーが challenge token を返す

3. フルスタットリクエスト送信
   → 0xFE 0xFD 0x00 + sessionId + challengeToken

4. サーバーが応答（プレイヤー数・プレイヤー名など）
```

```python
stat = query_server("localhost", 25565)
if stat["numplayers"] > 0:
    ssm.put_parameter(
        Name="/minecraft/last_player_seen",
        Value=str(int(time.time())),
        Overwrite=True
    )
```

---

## 自動停止の仕組み

Lambda が EventBridge から **5分おき**に呼ばれる

```python
last_seen = int(ssm.get_parameter("/minecraft/last_player_seen"))
absence = time.time() - last_seen

if absence >= 30 * 60:   # 30分以上不在
    ec2.stop_instances(InstanceIds=[GAME_SERVER_ID])
```

- プレイヤーがいれば `player-monitor` が SSM を更新し続ける → 止まらない
- いなくなると更新が止まり、30分後に Lambda が停止する
- EC2 同士は直接通信しない。**SSM が状態の中継役**

---

## やらかした: 深夜に EC2 が勝手に起動する

デプロイ直後、深夜なのに EC2 が起動・停止を繰り返してた

原因：**Minecraft クライアントはサーバー一覧を定期 ping してる**

当初は `next_state` の分岐前に StartInstances を呼んでいた

```python
# 修正前
if ec2_state == "stopped":
    await start_game_server()   # ping でも発火してしまう

if next_state == 1:   # ping
    ...
```

→ `next_state == 2`（ログイン）のブロック内に移動して解決

プロトコルちゃんと読んでから実装しましょう（戒め）

---

## 結果

| | 移行前 | 移行後 |
|--|--|--|
| 月額 | **$80** | **$23** |
| インフラ管理 | 手作業 | CDK で全部コード化 |
| 削除 | 怖くてできない | `cdk destroy --all` 一発 |

約 **70% コスト削減**

---

## まとめ

- Minecraft プロトコルを読んで `next_state` で ping と login を区別
- asyncio で軽量プロキシを実装、t4g.nano に常駐
- Query Protocol (UDP) でプレイヤー数を取得、SSM で状態共有
- Lambda が SSM の timestamp を見て自動停止
- 全部 CDK → `deploy` も `destroy` も一発

**コード公開中**: github.com/pktcat/minecraft_server

---

# ありがとうございました

質問あればどうぞ
