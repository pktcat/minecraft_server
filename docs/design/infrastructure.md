# インフラ設計 (CDK / AWS リソース)

## CDK スタック構成

```
MinecraftSgStack          (security-group-stack.ts)
       │
       ├──► MinecraftGameStack    (game-server-stack.ts)
       │           │
       │           ├──► MinecraftProxyStack   (proxy-stack.ts)
       │           │
       │           └──► MinecraftMonitorStack (monitoring-stack.ts)
       │
       └──► MinecraftDnsStack     (dns-stack.ts)
                   └── MinecraftProxyStack に依存 (EIP アドレス参照)
```

デプロイ順序は CDK が依存関係から自動解決する。

---

## スタック詳細

### 1. MinecraftSgStack

**ファイル**: [cdk/lib/security-group-stack.ts](../../cdk/lib/security-group-stack.ts)
**依存**: なし

#### 作成リソース

| リソース | 論理 ID | 名前 |
|---------|---------|------|
| SecurityGroup | ProxySg | `minecraft-proxy-sg` |
| SecurityGroup | GameSg | `minecraft-game-sg` |

#### セキュリティグループルール

**プロキシ SG (minecraft-proxy-sg)**:

| 方向 | プロトコル | ポート | 送信元/宛先 |
|------|-----------|--------|------------|
| Inbound | TCP | 25565 | 0.0.0.0/0 (プレイヤー全員) |
| Outbound | ALL | ALL | 0.0.0.0/0 (デフォルト全許可) |

**ゲーム SG (minecraft-game-sg)**:

| 方向 | プロトコル | ポート | 送信元/宛先 |
|------|-----------|--------|------------|
| Inbound | TCP | 25565 | プロキシ SG からのみ |
| Outbound | ALL | ALL | 0.0.0.0/0 (デフォルト全許可) |

> ゲームサーバーの Inbound はプロキシ SG からのみ許可。
> プレイヤーはプロキシ経由でしかアクセスできない。

#### エクスポート

```typescript
readonly proxySg: ec2.SecurityGroup
readonly gameSg: ec2.SecurityGroup
```

---

### 2. MinecraftGameStack

**ファイル**: [cdk/lib/game-server-stack.ts](../../cdk/lib/game-server-stack.ts)
**依存**: MinecraftSgStack

#### 作成リソース

| リソース | 論理 ID | 詳細 |
|---------|---------|------|
| IAM Role | GameServerRole | `minecraft-game-server-role` |
| S3 Asset | PlayerMonitorScript | player-monitor.py の配布用 |
| EC2 Instance | GameServer | t3.large, ap-northeast-1a |
| EBS Volume | (GameServer に付属) | 20GB gp3, DeleteOnTermination=false |

#### EC2 仕様

| 項目 | 値 |
|------|-----|
| インスタンスタイプ | t3.large (2vCPU / 8GB RAM) |
| AMI | Amazon Linux 2023 (最新) |
| アーキテクチャ | x86_64 |
| AZ | ap-northeast-1a |
| サブネット | デフォルト VPC パブリックサブネット |
| セキュリティグループ | minecraft-game-sg |
| キーペア | なし (SSM Session Manager のみ) |
| IMDSv2 | 必須 (requireImdsv2: true) |

#### EBS ボリューム

| 項目 | 値 |
|------|-----|
| デバイス名 | /dev/xvda (ルートボリューム) |
| サイズ | 20 GB |
| タイプ | gp3 |
| DeleteOnTermination | **false** (EC2 terminate 後もデータ保持) |

#### IAM ポリシー

| アクション | リソース | 用途 |
|-----------|---------|------|
| `AmazonSSMManagedInstanceCore` (管理ポリシー) | - | SSM Session Manager |
| `ssm:PutParameter`, `ssm:GetParameter` | `arn:aws:ssm:...:parameter/minecraft/*` | プレイヤー数の SSM 書き込み |

#### User Data (初回起動時のみ実行)

```bash
# 1. パッケージインストール
dnf install -y java-21-amazon-corretto-headless python3 python3-pip
pip3 install boto3

# 2. Minecraft ディレクトリ作成
mkdir -p /home/ec2-user/minecraft
chown ec2-user:ec2-user /home/ec2-user/minecraft

# 3. player-monitor.py を S3 Asset からダウンロード
aws s3 cp s3://<asset-bucket>/<key> /opt/player-monitor.py
chmod +x /opt/player-monitor.py

# 4. minecraft.service (systemd) を作成
#    ConditionFileExists: paper jar がなければ起動しない (データ移行前の保護)
#    ExecStartPre: server.properties に enable-query=true を自動設定
#    ExecStart: Java 21 + Aikar's Flags + paper-1.21.11-113.jar

# 5. player-monitor.service / player-monitor.timer を作成

# 6. サービス有効化
systemctl daemon-reload
systemctl enable minecraft.service
systemctl enable player-monitor.timer
systemctl start player-monitor.timer   # タイマーは即時起動
# ※ minecraft.service は start しない (jar 未配置のため)
```

#### minecraft.service の重要設定

```ini
ConditionFileExists=/home/ec2-user/minecraft/paper-1.21.11-113.jar
```
→ データ移行前に EC2 が起動しても Minecraft は立ち上がらない。

```ini
ExecStartPre=/bin/bash -c "grep -q '^enable-query=true' .../server.properties 2>/dev/null \
  || sed -i 's/^enable-query=.*/enable-query=true/' .../server.properties 2>/dev/null \
  || echo 'enable-query=true' >> .../server.properties"
```
→ `server.properties` に `enable-query=true` を自動付与 (Query Protocol の有効化)。

#### JVM 引数 (Aikar's Flags)

```
-Xms2G -Xmx6G
-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200
-XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch
-XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M
-XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4
-XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90
-XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32
-XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1
```

#### CloudFormation Outputs

| Output Key | 値 | Export Name |
|-----------|-----|-------------|
| GameServerInstanceId | インスタンス ID | `MinecraftGameServerInstanceId` |
| GameServerPrivateIp | プライベート IP | `MinecraftGameServerPrivateIp` |

---

### 3. MinecraftProxyStack

**ファイル**: [cdk/lib/proxy-stack.ts](../../cdk/lib/proxy-stack.ts)
**依存**: MinecraftSgStack, MinecraftGameStack

#### 作成リソース

| リソース | 論理 ID | 詳細 |
|---------|---------|------|
| IAM Role | ProxyRole | `minecraft-proxy-role` |
| S3 Asset | McProxyScript | mc-proxy.py の配布用 |
| EC2 Instance | ProxyServer | t4g.nano, ap-northeast-1a |
| CfnEIP | ProxyEip | Elastic IP |
| CfnEIPAssociation | ProxyEipAssoc | EIP ↔ ProxyServer 紐付け |

#### EC2 仕様

| 項目 | 値 |
|------|-----|
| インスタンスタイプ | t4g.nano (2vCPU / 0.5GB RAM) |
| AMI | Amazon Linux 2023 ARM64 (最新) |
| アーキテクチャ | ARM_64 (Graviton2) |
| AZ | ap-northeast-1a |
| セキュリティグループ | minecraft-proxy-sg |
| キーペア | なし |
| IMDSv2 | 必須 |
| EBS | ルートボリュームのみ (デフォルト) |

#### IAM ポリシー

| アクション | リソース | 用途 |
|-----------|---------|------|
| `AmazonSSMManagedInstanceCore` (管理ポリシー) | - | SSM Session Manager |
| `ec2:StartInstances` | ゲームサーバーインスタンスのみ | ゲームサーバー起動 |
| `ec2:DescribeInstances`, `ec2:DescribeInstanceStatus` | `*` | EC2 状態確認 (Describe は ARN 制限不可) |

#### User Data

```bash
# 1. Python + boto3 インストール
dnf install -y python3 python3-pip
pip3 install boto3

# 2. mc-proxy.py を S3 Asset からダウンロード
aws s3 cp s3://<asset-bucket>/<key> /opt/mc-proxy.py
chmod +x /opt/mc-proxy.py

# 3. mc-proxy.service (systemd) を作成・有効化・起動
#    環境変数: GAME_INSTANCE_ID=<実際のインスタンス ID>
systemctl daemon-reload
systemctl enable mc-proxy.service
systemctl start mc-proxy.service
```

#### CloudFormation Outputs

| Output Key | 値 | Export Name |
|-----------|-----|-------------|
| ProxyInstanceId | インスタンス ID | - |
| ProxyElasticIp | Elastic IP アドレス | `MinecraftProxyElasticIp` |

---

### 4. MinecraftMonitorStack

**ファイル**: [cdk/lib/monitoring-stack.ts](../../cdk/lib/monitoring-stack.ts)
**依存**: MinecraftGameStack

#### 作成リソース

| リソース | 論理 ID | 詳細 |
|---------|---------|------|
| Lambda Function | AutoShutdown | `minecraft-auto-shutdown` |
| EventBridge Rule | AutoShutdownSchedule | `minecraft-auto-shutdown-schedule` |

#### Lambda 設定

| 項目 | 値 |
|------|-----|
| 関数名 | `minecraft-auto-shutdown` |
| ランタイム | Python 3.12 |
| ハンドラー | `index.handler` |
| タイムアウト | 30 秒 |
| 環境変数 | `GAME_INSTANCE_ID=<ゲームサーバーインスタンス ID>` |

> `AWS_REGION` は Lambda ランタイムが自動設定するため環境変数不要。

#### Lambda IAM ポリシー

| アクション | リソース | 用途 |
|-----------|---------|------|
| `ec2:StopInstances` | ゲームサーバーインスタンスのみ | 停止 |
| `ec2:DescribeInstances`, `ec2:DescribeInstanceStatus` | `*` | 状態確認 |
| `ssm:GetParameter`, `ssm:PutParameter` | `/minecraft/*` | 最終プレイヤー時刻 |

#### EventBridge Rule

| 項目 | 値 |
|------|-----|
| ルール名 | `minecraft-auto-shutdown-schedule` |
| スケジュール | `rate(5 minutes)` |
| ターゲット | AutoShutdown Lambda |

---

### 5. MinecraftDnsStack

**ファイル**: [cdk/lib/dns-stack.ts](../../cdk/lib/dns-stack.ts)
**依存**: MinecraftProxyStack (EIP アドレス)

#### 作成リソース

| リソース | 論理 ID | 詳細 |
|---------|---------|------|
| PublicHostedZone | PktcatZone | `your-domain.com` |
| ARecord | MinecraftARecord | `minecraft.your-domain.com` → プロキシ EIP |

#### DNS 設定

| レコード | 値 |
|---------|-----|
| `minecraft.your-domain.com` | A レコード → プロキシ Elastic IP |
| TTL | 300 秒 |

> ホストゾーンの NS レコードは `cdk deploy` の Output に表示される。
> `your-domain.com` のドメイン登録時にこれらを指定する。

#### CloudFormation Outputs

| Output Key | 説明 |
|-----------|------|
| HostedZoneId | Route 53 ホストゾーン ID |
| NameServers | NS レコード (4つ、カンマ区切り) |
| MinecraftEndpoint | `minecraft.your-domain.com:25565` |

---

## ネットワーク設計

### VPC

デフォルト VPC (`vpc-xxxxxxxxxxxxxxxxx`) を `Vpc.fromLookup()` で参照。
新規 VPC は作成しない。

```typescript
const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });
```

### サブネット配置

両 EC2 ともパブリックサブネット (ap-northeast-1a) に配置。
SSM Session Manager はパブリックサブネット経由でインターネット経由接続するため、
NAT Gateway 不要。

---

## S3 Asset による スクリプト配布

CDK の `aws-s3-assets` を使い、ローカルの Python スクリプトを
デプロイ時に S3 へアップロードし、User Data でダウンロードする。

```typescript
const asset = new s3assets.Asset(this, "ScriptAsset", {
  path: path.join(__dirname, "../scripts/mc-proxy.py"),
});
asset.grantRead(role);
userData.addS3DownloadCommand({
  bucket: asset.bucket,
  bucketKey: asset.s3ObjectKey,
  localFile: "/opt/mc-proxy.py",
  region: this.region,
});
```

スクリプトの更新は `cdk deploy` で自動的に S3 へ反映される。
ただし EC2 の User Data は初回起動時のみ実行されるため、
スクリプト更新後に EC2 を反映させるには手動で再デプロイが必要。

---

## コスト内訳 (参考)

| リソース | 月額 |
|---------|------|
| プロキシ EC2 (t4g.nano, 常駐) | ~$3.5 |
| ゲームサーバー EBS 20GB gp3 | ~$1.6 (停止中も課金) |
| Elastic IP (EC2 に紐付き) | $0 |
| Route 53 ホストゾーン | $0.5 |
| Lambda (5分おき, 月 8,640 回) | ~$0 (無料枠内) |
| SSM Parameter Store | $0 (標準パラメータは無料) |
| S3 (Asset 保存) | ~$0 (数 KB) |
| **固定費合計** | **~$5.6** |
| ゲームサーバー EC2 (t3.large) | $0.104/h × プレイ時間 |
