import { Stack, StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

export class SecurityGroupStack extends Stack {
  readonly proxySg: ec2.SecurityGroup;
  readonly gameSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    // ─── プロキシ EC2 用 SG ───────────────────────────────────
    this.proxySg = new ec2.SecurityGroup(this, "ProxySg", {
      vpc,
      securityGroupName: "minecraft-proxy-sg",
      description: "Minecraft proxy EC2 - players connect here",
      allowAllOutbound: true,
    });
    // プレイヤーからの接続 (全世界)
    this.proxySg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(25565),
      "Minecraft Java Edition - players"
    );

    // ─── ゲームサーバー EC2 用 SG ─────────────────────────────
    this.gameSg = new ec2.SecurityGroup(this, "GameSg", {
      vpc,
      securityGroupName: "minecraft-game-sg",
      description: "Minecraft game server EC2 - only proxy can connect",
      allowAllOutbound: true,
    });
    // プロキシからの TCP 接続のみ許可
    this.gameSg.addIngressRule(
      this.proxySg,
      ec2.Port.tcp(25565),
      "Minecraft TCP from proxy"
    );
  }
}
