import * as path from "path";
import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";
import { SecurityGroupStack } from "./security-group-stack";
import { GameServerStack } from "./game-server-stack";

interface ProxyStackProps extends StackProps {
  sgStack: SecurityGroupStack;
  gameStack: GameServerStack;
}

export class ProxyStack extends Stack {
  /** プロキシ EC2 の Elastic IP アドレス (Route 53 A レコードに使用) */
  readonly eipAddress: string;

  constructor(scope: Construct, id: string, props: ProxyStackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });
    const gameInstanceId = props.gameStack.instance.instanceId;

    // ─── IAM ロール ───────────────────────────────────────────
    const role = new iam.Role(this, "ProxyRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      roleName: "minecraft-proxy-role",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });

    // ゲームサーバー EC2 の StartInstances (特定インスタンスのみ)
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:StartInstances"],
        resources: [
          `arn:aws:ec2:${this.region}:${this.account}:instance/${gameInstanceId}`,
        ],
      })
    );

    // DescribeInstances はリソース制限不可のため * で許可
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeInstances", "ec2:DescribeInstanceStatus"],
        resources: ["*"],
      })
    );

    // ─── mc-proxy.py を S3 Asset として配布 ───────────────────
    const proxyScriptAsset = new s3assets.Asset(this, "McProxyScript", {
      path: path.join(__dirname, "../scripts/mc-proxy.py"),
    });
    proxyScriptAsset.grantRead(role);

    // ─── User Data ────────────────────────────────────────────
    const userData = ec2.UserData.forLinux();

    // Python3 と boto3 をインストール
    userData.addCommands(
      "dnf install -y python3 python3-pip",
      "pip3 install boto3"
    );

    // mc-proxy.py をダウンロード
    userData.addS3DownloadCommand({
      bucket: proxyScriptAsset.bucket,
      bucketKey: proxyScriptAsset.s3ObjectKey,
      localFile: "/opt/mc-proxy.py",
      region: this.region,
    });
    userData.addCommands("chmod +x /opt/mc-proxy.py");

    // mc-proxy.service (systemd)
    // GAME_INSTANCE_ID は CloudFormation によって実際のインスタンス ID に展開される
    userData.addCommands(
      `cat > /etc/systemd/system/mc-proxy.service << 'SYSTEMD_EOF'
[Unit]
Description=Minecraft Wake-on-Demand Proxy
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/mc-proxy.py
Environment=GAME_INSTANCE_ID=${gameInstanceId}
Environment=GAME_PORT=25565
Environment=LISTEN_PORT=25565
Environment=AWS_DEFAULT_REGION=${this.region}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SYSTEMD_EOF`,
      "systemctl daemon-reload",
      "systemctl enable mc-proxy.service",
      "systemctl start mc-proxy.service"
    );

    // ─── EC2 インスタンス (t4g.nano / ARM Graviton2) ──────────
    const instance = new ec2.Instance(this, "ProxyServer", {
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.NANO
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
        availabilityZones: ["ap-northeast-1a"],
      },
      securityGroup: props.sgStack.proxySg,
      role,
      userData,
      requireImdsv2: true,
    });

    // ─── Elastic IP ───────────────────────────────────────────
    const eip = new ec2.CfnEIP(this, "ProxyEip", {
      tags: [{ key: "Name", value: "minecraft-proxy-eip" }],
    });

    new ec2.CfnEIPAssociation(this, "ProxyEipAssoc", {
      instanceId: instance.instanceId,
      allocationId: eip.attrAllocationId,
    });

    // CfnEIP.attrPublicIp は CloudFormation トークンのため、
    // dns-stack でそのまま参照できる
    this.eipAddress = eip.attrPublicIp;

    // ─── Outputs ──────────────────────────────────────────────
    new CfnOutput(this, "ProxyInstanceId", {
      value: instance.instanceId,
      description: "プロキシ EC2 インスタンス ID",
    });

    new CfnOutput(this, "ProxyElasticIp", {
      value: this.eipAddress,
      description: "プロキシ Elastic IP (minecraft.your-domain.com が指す先)",
      exportName: "MinecraftProxyElasticIp",
    });
  }
}
