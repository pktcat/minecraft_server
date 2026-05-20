import * as path from "path";
import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";
import { SecurityGroupStack } from "./security-group-stack";

interface GameServerStackProps extends StackProps {
  sgStack: SecurityGroupStack;
}

export class GameServerStack extends Stack {
  readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: GameServerStackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    // ─── IAM ロール ───────────────────────────────────────────
    const role = new iam.Role(this, "GameServerRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      roleName: "minecraft-game-server-role",
      managedPolicies: [
        // SSM Session Manager によるアクセスに必要
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });

    // プレイヤー監視スクリプトが SSM Parameter Store に書き込む権限
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:PutParameter", "ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/*`,
        ],
      })
    );

    // ─── player-monitor.py を S3 Asset として配布 ─────────────
    const playerMonitorAsset = new s3assets.Asset(this, "PlayerMonitorScript", {
      path: path.join(__dirname, "../scripts/player-monitor.py"),
    });
    playerMonitorAsset.grantRead(role);

    // ─── User Data ────────────────────────────────────────────
    const userData = ec2.UserData.forLinux();

    // Java 21 と Python3 をインストール
    userData.addCommands(
      "dnf install -y java-21-amazon-corretto-headless python3 python3-pip",
      "pip3 install boto3"
    );

    // minecraft ディレクトリ作成 (データ移行先)
    userData.addCommands(
      "mkdir -p /home/ec2-user/minecraft",
      "chown ec2-user:ec2-user /home/ec2-user/minecraft"
    );

    // player-monitor.py をダウンロード
    userData.addS3DownloadCommand({
      bucket: playerMonitorAsset.bucket,
      bucketKey: playerMonitorAsset.s3ObjectKey,
      localFile: "/opt/player-monitor.py",
      region: this.region,
    });
    userData.addCommands("chmod +x /opt/player-monitor.py");

    // minecraft.service (systemd)
    userData.addCommands(
      `cat > /etc/systemd/system/minecraft.service << 'SYSTEMD_EOF'
[Unit]
Description=Minecraft Paper Server
After=network.target
# Paper jar が存在しない場合は起動しない (データ移行前)
ConditionFileExists=/home/ec2-user/minecraft/paper-1.21.11-113.jar

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/minecraft
# 起動前に enable-query=true を確保する
ExecStartPre=/bin/bash -c "grep -q '^enable-query=true' /home/ec2-user/minecraft/server.properties 2>/dev/null || sed -i 's/^enable-query=.*/enable-query=true/' /home/ec2-user/minecraft/server.properties 2>/dev/null || echo 'enable-query=true' >> /home/ec2-user/minecraft/server.properties"
ExecStart=/usr/bin/java \\
  -Xms2G -Xmx6G \\
  -XX:+UseG1GC \\
  -XX:+ParallelRefProcEnabled \\
  -XX:MaxGCPauseMillis=200 \\
  -XX:+UnlockExperimentalVMOptions \\
  -XX:+DisableExplicitGC \\
  -XX:+AlwaysPreTouch \\
  -XX:G1NewSizePercent=30 \\
  -XX:G1MaxNewSizePercent=40 \\
  -XX:G1HeapRegionSize=8M \\
  -XX:G1ReservePercent=20 \\
  -XX:G1HeapWastePercent=5 \\
  -XX:G1MixedGCCountTarget=4 \\
  -XX:InitiatingHeapOccupancyPercent=15 \\
  -XX:G1MixedGCLiveThresholdPercent=90 \\
  -XX:G1RSetUpdatingPauseTimePercent=5 \\
  -XX:SurvivorRatio=32 \\
  -XX:+PerfDisableSharedMem \\
  -XX:MaxTenuringThreshold=1 \\
  -Dusing.aikars.flags=https://mcflags.emc.gs \\
  -Daikars.new.flags=true \\
  -jar paper-1.21.11-113.jar \\
  --nogui
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
SYSTEMD_EOF`
    );

    // player-monitor.service (systemd oneshot)
    userData.addCommands(
      `cat > /etc/systemd/system/player-monitor.service << 'SYSTEMD_EOF'
[Unit]
Description=Minecraft Player Monitor (oneshot)
After=minecraft.service

[Service]
Type=oneshot
User=ec2-user
ExecStart=/usr/bin/python3 /opt/player-monitor.py
Environment=AWS_DEFAULT_REGION=${this.region}
SYSTEMD_EOF`
    );

    // player-monitor.timer (5 分おき)
    userData.addCommands(
      `cat > /etc/systemd/system/player-monitor.timer << 'SYSTEMD_EOF'
[Unit]
Description=Run Minecraft player monitor every 5 minutes

[Timer]
OnBootSec=90s
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
SYSTEMD_EOF`
    );

    // サービス有効化 (start はしない: データ移行前)
    userData.addCommands(
      "systemctl daemon-reload",
      "systemctl enable minecraft.service",
      "systemctl enable player-monitor.timer",
      // タイマーは即時起動 (Minecraft がなければ player-monitor も graceful に終了する)
      "systemctl start player-monitor.timer"
    );

    // ─── EC2 インスタンス ──────────────────────────────────────
    this.instance = new ec2.Instance(this, "GameServer", {
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.LARGE
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
        availabilityZones: ["ap-northeast-1a"],
      },
      securityGroup: props.sgStack.gameSg,
      role,
      userData,
      // キーペアなし (SSM のみでアクセス)
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(20, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            deleteOnTermination: false, // ← 停止・terminate してもデータを保持
          }),
        },
      ],
    });

    // ─── Outputs ──────────────────────────────────────────────
    new CfnOutput(this, "GameServerInstanceId", {
      value: this.instance.instanceId,
      description: "ゲームサーバー EC2 インスタンス ID",
      exportName: "MinecraftGameServerInstanceId",
    });

    new CfnOutput(this, "GameServerPrivateIp", {
      value: this.instance.instancePrivateIp,
      description: "ゲームサーバー プライベート IP",
      exportName: "MinecraftGameServerPrivateIp",
    });
  }
}
