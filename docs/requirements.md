# Minecraft サーバー AWS 構築要件定義書

作成日: 2026-02-28
ステータス: **CDK 実装完了・デプロイ待ち**

---

## 1. 背景・目的

現在 AWS EC2 (t3.large / ap-northeast-1) で Minecraft サーバーを 24 時間常駐稼働させており、
コストが高いため、以下を目的としてアーキテクチャを刷新する。

- **コスト削減**: 誰も遊んでいない時間帯はゲームサーバーを停止する
- **IaC 化**: AWS CDK によりインフラをコードで管理する
- **ドメイン取得**: 固定的な接続先を確保する（動的 IP からの脱却）

---

## 2. 現状 (As-Is)

AWS CLI で調査した実際の構成:

| 項目 | 内容 |
|------|------|
| インスタンス ID | `i-xxxxxxxxxxxxxxxxx` |
| インスタンスタイプ | t3.large |
| 名前タグ | minecraft-server |
| 稼働状態 | running |
| パブリック IP | xx.xx.xx.xx (動的、EIP なし) |
| プライベート IP | xxx.xxx.xxx.xxx |
| VPC | `vpc-xxxxxxxxxxxxxxxxx` (デフォルト VPC, 172.31.0.0/16) |
| サブネット | `subnet-xxxxxxxxxxxxxxxxx` (ap-northeast-1a, パブリック) |
| IAM ロール | **なし** ← 現在は IAM ロール未設定 |
| キーペア | your-keypair-name |
| Elastic IP | **なし** ← 動的 IP のみ |
| Route 53 | **なし** ← ホストゾーン未作成 |
| 月額コスト | 約 $50〜70 |

### 現状のセキュリティグループ (sg-0e2667137757ae0f5: launch-wizard-1)

| プロトコル | ポート | 送信元 | 用途 |
|-----------|--------|--------|------|
| TCP | 22 | xx.xx.xx.xx/32 (固定 IP) | SSH |
| TCP | 25565 | 0.0.0.0/0 | Minecraft |

### 現状の EBS ボリューム ⚠️

| 項目 | 現状 | 新設計 |
|------|------|--------|
| ボリューム ID | `vol-xxxxxxxxxxxxxxxxx` | 新規作成 |
| サイズ | **8 GB** | **20 GB** |
| タイプ | gp3 | gp3 |
| **DeleteOnTermination** | **True ← 危険!** | **False に変更必須** |

> ⚠️ **現在の EBS は DeleteOnTermination=True**。誤って EC2 を terminate するとワールドデータが消える。
> 新構成では必ず `DeleteOnTermination=False` に設定する。

---

## 3. 要件一覧 (To-Be)

### 3-1. 機能要件

#### FR-01: Java Edition 対応
- **Minecraft Java Edition** に対応する
- ポート: **TCP 25565**（Java Edition 標準）
- プロキシも Java Edition プロトコル対応のものを使用する

#### FR-02: プロキシ EC2 によるウェイクアップ
- プレイヤーが Minecraft クライアントからサーバーに接続要求を送ると、**常駐するプロキシ EC2** が受け取る
- プロキシは**本番 EC2 が停止中**であれば自動的に起動 (StartInstances API) する
- 本番 EC2 の起動完了後、プレイヤーのセッションをプロキシから本番 EC2 へ転送する
- 本番 EC2 の起動中はプレイヤーに対して「サーバー起動中」の MOTD メッセージを返す

#### FR-03: プレイヤー不在時の自動停止
- ゲーム内でプレイヤーが **30 分間不在** になった場合、本番 EC2 を自動停止する
- 「プレイヤー不在」の定義: オンラインプレイヤー数 = 0 が 30 分継続

#### FR-04: ドメイン名による接続 (Route 53)
- **Route 53** でドメインを新規取得し、固定のドメイン名でゲームサーバーに接続できる
- EC2 の IP が変わっても接続先ドメインは不変
- プロキシ EC2 に Elastic IP を紐付け、A レコードで解決する

#### FR-05: AWS CDK による IaC 管理
- 全インフラリソースを AWS CDK (TypeScript) で定義・管理する
- `cdk deploy` 一発で環境を構築できる

---

### 3-2. 非機能要件

#### NFR-01: コスト削減
- ゲームプレイ時間以外は本番 EC2 を停止し、EC2 コストを大幅削減する
- プロキシ EC2 は最小インスタンスタイプ (t4g.nano 相当) で常時稼働

#### NFR-02: 起動レイテンシ（許容範囲）
- 本番 EC2 が停止状態からプレイヤーが接続できるまでの想定時間:
  - EC2 起動: 約 30〜60 秒
  - Minecraft サーバープロセス起動: 約 30〜90 秒（ワールドサイズに依存）
  - **合計: 最大 約 2〜3 分** を許容する設計とする

#### NFR-03: ワールドデータの永続化
- 本番 EC2 を停止・起動してもワールドデータが消えない
- EBS ボリューム (gp3) でルートボリュームとして永続化

---

## 4. アーキテクチャ

```
[プレイヤー PC]
      |
      | TCP :25565
      v
+------------------------------+
|   プロキシ EC2 (t4g.nano)    |
|   Elastic IP 固定           |
|                              |
|  ┌──────────────────────┐   |
|  │  mc-proxy.py         │   |
|  │  (Python asyncio)    │   |
|  │  ・接続受付           │   |
|  │  ・本番 EC2 起動判定  │   |
|  │  ・MOTD/Disconnect返却│   |
|  │  ・TCP 双方向転送     │   |
|  └──────────────────────┘   |
+---------------|--------------+
                | StartInstances API (IAM Role)
                | プライベート IP でプロキシ転送
                v
+------------------------------+
|   本番 EC2 (t3.large)        |
|   ※プレイ時間のみ起動        |
|                              |
|  ┌──────────────────────┐   |
|  │  Minecraft Server    │   |
|  │  (Paper 1.21.11)     │   |
|  └──────────────────────┘   |
|  ┌──────────────────────┐   |
|  │  player-monitor.py   │   |
|  │  (5分おき systemd)   │   |
|  │  → SSM Parameter     │   |
|  └──────────────────────┘   |
|  ┌──────────────────────┐   |
|  │  EBS gp3 20GB        │   |
|  │  (ワールドデータ)     │   |
|  └──────────────────────┘   |
+------------------------------+

[Route 53]
  your-domain.com → A レコード (minecraft) → プロキシ EC2 の Elastic IP

[Lambda + EventBridge Rule (5分おき)]
  SSM Parameter Store /minecraft/last_player_seen を参照
  → (起動後30分超 && 最終プレイヤー確認から30分超) → StopInstances API
```

---

## 5. コンポーネント詳細

### 5-1. プロキシ EC2

| 項目 | 内容 |
|------|------|
| インスタンスタイプ | t4g.nano (ARM, 2vCPU / 0.5GB RAM) |
| OS | Amazon Linux 2023 |
| 役割 | 接続受付・本番 EC2 起動・トラフィック転送 |
| 稼働 | 24 時間常駐 |
| EIP | Elastic IP を割り当て (固定 IP) |
| ソフトウェア | **mc-proxy.py** (カスタム Python asyncio スクリプト) |

#### プロキシソフトウェア: カスタム Python asyncio スクリプト (mc-proxy.py)

infrared や mc-router は AWS EC2 のウェイクオンデマンドに対応していないため、
Minecraft Java Edition プロトコルを直接実装したカスタムスクリプトを採用。

**動作フロー:**
```
1. プレイヤーがドメインに接続 (TCP 25565)
2. mc-proxy.py が Handshake パケットを解析 (next_state: Status/Login)
3. boto3 でゲーム EC2 の状態を確認
4a. running + 接続可能 → asyncio で TCP 双方向パイプ (透過プロキシ)
4b. running + 接続不可 (Minecraft 起動中) → "Server is starting..." MOTD 返却
4c. stopped → StartInstances API 呼び出し → MOTD/Disconnect 返却
4d. pending/stopping → MOTD/Disconnect 返却 (StartInstances は呼ばない)
5. ゲーム EC2 と Minecraft 起動完了後、次回接続で透過転送
```

---

### 5-2. 本番 EC2

| 項目 | 内容 |
|------|------|
| インスタンスタイプ | t3.large (2 vCPU / 8 GB RAM) ※下記の代替案参照 |
| OS | Amazon Linux 2023 |
| ストレージ | EBS gp3 **20 GB** (ルートボリューム、停止しても削除しない) |
| 最大プレイヤー数 | 10 名 |
| 起動トリガー | プロキシ EC2 からの StartInstances API |
| 停止トリガー | Lambda からの StopInstances API |

#### インスタンスタイプ代替案: t3.medium も選択肢

| タイプ | スペック | Paper 10人時の JVM ヒープ | 月額 (1日3h) | 推奨度 |
|--------|---------|--------------------------|-------------|--------|
| **t3.large** | 2vCPU / 8GB | -Xmx6G (余裕あり) | 約 $9.4 | ⭐⭐⭐ 安定重視 |
| **t3.medium** | 2vCPU / 4GB | -Xmx3G (十分) | 約 $4.7 | ⭐⭐ コスト重視 |

> Paper は vanilla より大幅に最適化されているため、プラグインが重くなければ t3.medium でも 10 人は快適に動作する。
> 移行時は t3.large で様子を見て、余裕があれば t3.medium へダウングレードする方針を推奨。

#### EBS サイズ根拠

| 用途 | サイズ |
|------|--------|
| 現在のワールドデータ (jar・設定・スクリプト含む) | 1.4 GB |
| OS (Amazon Linux 2023) | 約 3 GB |
| Java 21 ランタイム | 約 0.3 GB |
| 将来の成長バッファ (ワールド拡張・ログ等) | 約 15 GB |
| **合計 → 20 GB で余裕あり** | **20 GB** |

---

### 5-3. プレイヤー監視 (自動停止)

**採用方式: ゲームサーバー上の cron → SSM Parameter Store → Lambda (VPC 不要)**

| 項目 | 内容 |
|------|------|
| 監視間隔 | 5 分おき (systemd timer on game server + EventBridge Rule for Lambda) |
| プレイヤー数取得 | ゲームサーバー上の `player-monitor.py` が Query Protocol (UDP localhost:25565) でクエリ |
| データ記録 | プレイヤー数 > 0 の場合、SSM Parameter Store `/minecraft/last_player_seen` を現在時刻で更新 |
| 停止判定 | Lambda が 5 分おきに起動: EC2 running かつ (起動後 30 分超 && last_player_seen が 30 分以上前) → 停止 |
| グレースピリオド | EC2 起動後 30 分間はシャットダウンしない (EC2 LaunchTime で判定) |
| 停止実行 | Lambda → StopInstances API |

**この方式を選んだ理由:**
- Lambda を VPC 内に入れる必要がなく、NAT Gateway ($32/月) のコストが不要
- ゲームサーバーが SSM に書き込み、Lambda が読むだけのシンプルな疎結合設計

---

### 5-4. ドメイン・DNS

| 項目 | 内容 |
|------|------|
| ドメイン名 | **your-domain.com** |
| 接続エンドポイント | **minecraft.your-domain.com:25565** |
| 取得方法 | Route 53 コンソールから手動登録 (cdk deploy 後に NS レコードを確認して設定) |
| ホストゾーン | Route 53 パブリックホストゾーン (CDK で自動作成) |
| レコード | `minecraft.your-domain.com` A レコード → プロキシ EC2 の Elastic IP |
| TTL | 300 秒 |

---

### 5-5. ドメイン名 (確定)

| 項目 | 内容 |
|------|------|
| ドメイン | `your-domain.com` |
| Minecraft 接続先 | `minecraft.your-domain.com` |

---

### 5-6. Minecraft サーバー (Paper) 設定

| 項目 | 設定値 | 備考 |
|------|--------|------|
| サーバーソフト | **Paper 1.21.11 build 113** | jar: `paper-1.21.11-113.jar` |
| Java バージョン | Java 21 (LTS) | Paper 1.21.x の推奨 |
| JVM ヒープ (t3.large) | `-Xms2G -Xmx6G` | Aikar's Flags を併用 |
| JVM ヒープ (t3.medium) | `-Xms1G -Xmx3G` | |
| Query Protocol | `enable-query=true` | Lambda によるプレイヤー数監視に必須 |
| Query ポート | UDP 25565 | セキュリティグループで Lambda からのみ許可 |
| max-players | 10 | |
| server-port | TCP 25565 | |

**Aikar's Flags (Paper 推奨 JVM 引数):**
```
-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200
-XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC
-XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40
-XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5
-XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15
-XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5
-XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1
```

---

### 5-7. 現行サーバーのファイル構成と移行対象

現在のサーバーディレクトリ: `/home/ec2-user/minecraft/`

```
minecraft/
├── paper-1.21.11-113.jar       # サーバー本体 (54.8 MB)
├── start.sh                    # 起動スクリプト ★ systemd に置き換える
├── server.properties           # サーバー設定
├── bukkit.yml / spigot.yml     # Paper/Spigot 設定
├── eula.txt
├── ops.json / whitelist.json / banned-*.json
├── plugins/                    # プラグイン (19 エントリ) ★ 移行必須
├── world/                      # メインワールド ★ 移行必須
├── world_nether/               # ネザー ★ 移行必須
├── world_the_end/              # エンド ★ 移行必須
├── config/                     # Paper 設定ディレクトリ
├── bundler/ cache/ libraries/ versions/  # Paper 内部ファイル
├── logs/                       # ログ (移行不要)
│
├── fishing_competition.sh      # ★ カスタムスクリプト
├── job_ranking.sh              # ★ カスタムスクリプト
├── maintenance_announce.sh     # ★ カスタムスクリプト
└── tips.sh                     # ★ カスタムスクリプト
```

#### カスタムスクリプトの扱い (解決済み: Q-19)

| スクリプト | 移行方針 |
|-----------|---------|
| `fishing_competition.sh` | **移行不要** (手動実行のみ・今後使用しない) |
| `job_ranking.sh` | **移行不要** (手動実行のみ・今後使用しない) |
| `maintenance_announce.sh` | **移行不要** (手動実行のみ・今後使用しない) |
| `tips.sh` | **廃止** |

シェルスクリプトは全て不要となり、移行対象はサーバー本体ファイルのみ。

#### 移行方針

新 EC2 の EBS に既存データを移行する手順 (移行時に実施):
1. 新 EC2 を起動し、既存 EC2 から `rsync` または `aws s3 cp` でファイルをコピー
2. `start.sh` を **systemd サービス** (`minecraft.service`) に置き換える
3. cron 設定を新 EC2 に引き継ぐ

**systemd サービス化する理由:**
- EC2 起動時に自動的に Minecraft サーバーが立ち上がる
- プロキシ EC2 が StartInstances → EC2 が起動 → systemd が自動で Paper を起動、という流れが自然に実現できる
- プロセス監視・再起動が自動化される

---

## 6. ネットワーク設計

### VPC 方針: デフォルト VPC を使用

現状もデフォルト VPC (`vpc-xxxxxxxxxxxxxxxxx`) を使用しており、CDK でも同じ VPC を使う。
- 全サブネットがパブリック → EC2 はパブリック IP を持ち、SSM も NAT Gateway なしで動作する
- プロキシ EC2・本番 EC2 ともに ap-northeast-1a (`subnet-xxxxxxxxxxxxxxxxx`) に配置（現行踏襲）

### セキュリティグループ設計 (新規作成)

#### プロキシ EC2 用 SG

| 方向 | プロトコル | ポート | 送信元/宛先 | 用途 |
|------|-----------|--------|------------|------|
| Inbound | TCP | 25565 | 0.0.0.0/0 | プレイヤー接続 |
| Outbound | TCP | 25565 | ゲームサーバー SG | 本番 EC2 へ転送 |
| Outbound | TCP | 443 | 0.0.0.0/0 | AWS API (SSM, EC2 API) |

#### 本番 EC2 用 SG

| 方向 | プロトコル | ポート | 送信元/宛先 | 用途 |
|------|-----------|--------|------------|------|
| Inbound | TCP | 25565 | プロキシ SG のみ | mc-proxy.py からの転送 |
| Outbound | TCP | 443 | 0.0.0.0/0 | SSM, Paper アップデート等 |

> SSH (TCP 22) のインバウンドは**不要**。SSM (Session Manager) を使用するため。
> Minecraft Query (UDP 25565) はゲームサーバー自身が localhost でクエリするため、
> Lambda を VPC に入れる必要はなく、Lambda 用 SG も不要。

---

## 7. IAM 権限設計

> 現状は EC2 に IAM ロールが設定されていない。新構成では全リソースに IAM ロールを付与する。

| リソース | IAM ポリシー | 用途 |
|----------|------------|------|
| プロキシ EC2 ロール | `AmazonSSMManagedInstanceCore` | Session Manager でのアクセス |
| プロキシ EC2 ロール | `ec2:StartInstances` (本番 EC2 インスタンスのみ) | 本番 EC2 の起動 |
| プロキシ EC2 ロール | `ec2:DescribeInstances`, `ec2:DescribeInstanceStatus` (`*`) | EC2 状態確認 |
| 本番 EC2 ロール | `AmazonSSMManagedInstanceCore` | Session Manager でのアクセス |
| 本番 EC2 ロール | `ssm:PutParameter`, `ssm:GetParameter` (`/minecraft/*`) | プレイヤー数の SSM 書き込み |
| Lambda ロール | `ec2:StopInstances` (本番 EC2 インスタンスのみ) | 本番 EC2 の停止 |
| Lambda ロール | `ec2:DescribeInstances`, `ec2:DescribeInstanceStatus` (`*`) | EC2 状態確認 |
| Lambda ロール | `ssm:GetParameter`, `ssm:PutParameter` (`/minecraft/*`) | 最終プレイヤー時刻の読み書き |

---

## 8. CDK スタック構成

```
cdk/
├── bin/
│   └── minecraft-server.ts        # CDK App エントリポイント ✅
├── lib/
│   ├── security-group-stack.ts    # SG (プロキシ用・ゲーム用) ✅
│   ├── proxy-stack.ts             # プロキシ EC2 (t4g.nano), EIP, IAM Role ✅
│   ├── game-server-stack.ts       # 本番 EC2 (t3.large), EBS 20GB ✅
│   ├── monitoring-stack.ts        # Lambda, EventBridge Rule (5分おき) ✅
│   └── dns-stack.ts               # Route 53 ホストゾーン + A レコード ✅
├── scripts/
│   ├── mc-proxy.py                # プロキシ: 接続検知・EC2 起動・TCP 転送 ✅
│   └── player-monitor.py         # ゲームサーバー: プレイヤー数 → SSM ✅
└── lambda/
    └── auto-shutdown/
        └── index.py               # 自動停止 Lambda ✅
```

> VPC は既存のデフォルト VPC (`vpc-xxxxxxxxxxxxxxxxx`) を `Vpc.fromLookup()` で参照する。
> `cdk synth` 確認済み。`cdk bootstrap` 後に `cdk deploy --all` でデプロイ可能。

---

## 9. 確定要件一覧

### 解決済み ✅ (全項目)

| No. | 項目 | 決定内容 |
|-----|------|---------|
| Q-01 | Minecraft エディション | **Java Edition** |
| Q-02 | ドメイン取得先 | **Route 53 で新規取得** |
| Q-03 | ドメイン名 | **your-domain.com** (接続先: `minecraft.your-domain.com:25565`) |
| Q-04 | プロキシ EC2 常駐 | **OK（24h常駐）** |
| Q-05 | プロキシ実装 | **カスタム Python asyncio スクリプト** (`mc-proxy.py`) |
| Q-06 | 本番 EC2 OS | **Amazon Linux 2023** |
| Q-07 | Minecraft バージョン | **Paper 1.21.11 build 113** (`paper-1.21.11-113.jar`) |
| Q-08 | サーバーソフトウェア | **Paper** |
| Q-09 | 最大プレイヤー数 | **10 名** |
| Q-10 | ワールドデータサイズ | **1.4 GiB → EBS 20 GB で設計** |
| Q-12 | バックアップ | **不要** |
| Q-14 | SSH アクセス方式 | **Session Manager (SSM) のみ**。SSH ポート不要 |
| Q-15 | 通知 | **不要** |
| Q-17 | 複数環境 | **不要 (prod のみ)** |
| Q-18 | 既存 VPC | **デフォルト VPC を使用** (`vpc-xxxxxxxxxxxxxxxxx`) |
| Q-19 | カスタムスクリプト | **全て移行不要・廃止** |

---

## 9. ドメイン推奨案

### TLD の選択肢（Route 53 で登録可能なもの）

| TLD | 年額 | 特徴 | 推奨度 |
|-----|------|------|--------|
| **.com** | $13/年 | 最も汎用的・信頼性高い | ⭐⭐⭐ |
| **.net** | $11/年 | .com の次に定番、やや安い | ⭐⭐⭐ |
| **.click** | $3/年 | 格安。ゲーム用途なら悪くない | ⭐⭐ |

> **注意: `.gg` は Route 53 では登録不可。** ゲーミング向けで人気の TLD だが、
> 使いたい場合は Namecheap 等の外部レジストラで取得し、
> Route 53 をネームサーバーとして委任する構成になる (少し手間が増える)。

### ドメイン命名のポイント

- **短い**: 友達に口頭で伝えやすい (6 文字以内が理想)
- **覚えやすい**: 発音できる英単語か、意味のある略称
- **拡張性**: Minecraft 専用にせず、汎用的な名前にしておくと将来他のサービスにも使える

### 命名パターン例

接続アドレスとして `play.XXXX.com` や `mc.XXXX.com` の形式を使うと
ベースドメイン (`XXXX.com`) を他の用途にも転用できる。

```
例:
  ベースドメイン: myfarm.net
  Minecraft接続先: play.myfarm.net または mc.myfarm.net
```

**名前のアイデア出し方:**
- サーバーのテーマ・ルール・雰囲気から考える (サバイバル、クリエイティブ、RPG 等)
- メンバー内の共通ワード・ニックネームを使う
- 短い英単語 2 つの組み合わせ (例: `ironcraft`, `pixelbase`, `skyblock` 等のイメージで)

---

## 10. コスト詳細

### Route 53 ドメイン取得コスト

| 項目 | コスト |
|------|--------|
| ドメイン登録料 (.com) | $13/年 ≒ 約 $1.1/月 |
| ドメイン登録料 (.net) | $11/年 ≒ 約 $0.9/月 |
| Route 53 ホストゾーン | $0.50/月 |
| **ドメイン合計 (.com)** | **約 $1.6/月 (≒ 約 240 円/月)** |

### 全体コスト比較

| リソース | 現状 | 変更後 |
|----------|------|--------|
| 本番 EC2 | $50〜70/月 (24h 常駐) | プレイ時間分のみ |
| プロキシ EC2 (t4g.nano) | なし | $3.5/月 |
| EBS gp3 **20 GB** | 込み | **$1.6/月** (停止中も課金) |
| Elastic IP | なし | $0 (EC2 attach 中は無料) |
| Route 53 ホストゾーン | なし | $0.5/月 |
| ドメイン (.com) | なし | $1.1/月 ($13/年) |
| **固定費合計** | - | **約 $6.7/月** |
| **合計** | **$50〜70/月** | **プレイ時間次第 (下表)** |

### 1日のプレイ時間別シミュレーション

| インスタンス | 料金/時間 |
|------------|---------|
| t3.large (ap-northeast-1) | $0.104/h |
| t3.medium (ap-northeast-1) | $0.052/h |

| 1日あたりの プレイ時間 | t3.large 月額 | t3.medium 月額 | 固定費 | **t3.large 合計** | **t3.medium 合計** | 現状比 (t3.l) |
|----------------------|-------------|---------------|--------|-----------------|-----------------|--------------|
| 1 時間/日 (30h/月) | $3.1 | $1.6 | $6.7 | **$9.8** | **$8.3** | **-83%** |
| 3 時間/日 (90h/月) | $9.4 | $4.7 | $6.7 | **$16.1** | **$11.4** | **-73%** |
| 6 時間/日 (180h/月) | $18.7 | $9.4 | $6.7 | **$25.4** | **$16.1** | **-56%** |
| 10 時間/日 (300h/月) | $31.2 | $15.6 | $6.7 | **$37.9** | **$22.3** | **-35%** |

---

## 12. 次のステップ

1. [x] 要件定義完了・AWS 現状調査完了
2. [x] CDK プロジェクト初期化 (`cdk init app --language typescript`)
3. [x] `security-group-stack.ts` 実装完了
4. [x] `proxy-stack.ts` 実装完了 (mc-proxy.py + EIP + IAM)
5. [x] `game-server-stack.ts` 実装完了 (systemd + player-monitor.py)
6. [x] `monitoring-stack.ts` 実装完了 (Lambda + EventBridge)
7. [x] `dns-stack.ts` 実装完了 (your-domain.com + minecraft サブドメイン)
8. [x] `cdk synth` 確認済み (全 5 スタック正常)
9. [ ] **`cdk bootstrap --profile micron-aws`** (初回のみ)
10. [ ] **`cdk deploy --all --profile micron-aws`** でインフラ構築
11. [ ] **`your-domain.com` をRoute 53 コンソールで手動登録** し、CDK 出力の NS レコードを設定
12. [ ] 既存ワールドデータ (1.4 GiB) を新 EC2 の EBS へ移行する
    - 旧 EC2 から新 EC2 へ `rsync` または S3 経由でコピー
    - `start.sh` は削除 (systemd サービスに置き換え済み)
13. [ ] 動作確認 (SSM Session Manager 接続・mc-proxy.service 起動確認・Minecraft 接続テスト)
14. [ ] 動作確認後、旧 EC2 (`i-xxxxxxxxxxxxxxxxx`) を terminate する

### ⚠️ 移行時の注意事項

- 旧 EC2 の EBS は `DeleteOnTermination=True` のため、**terminate 前に必ずデータをコピーすること**
- 旧 EC2 には IAM ロールがないため、S3 経由でのデータ移行は新 EC2 側から pull する形にする
  - または: 旧 EC2 に一時的に IAM ロールを付与して `aws s3 sync` でアップロードする
- 移行完了・動作確認が取れるまで旧 EC2 は停止状態で保持すること（terminate しない）
