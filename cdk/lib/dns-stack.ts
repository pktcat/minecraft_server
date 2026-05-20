import { CfnOutput, Duration, Fn, Stack, StackProps } from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import { ProxyStack } from "./proxy-stack";

interface DnsStackProps extends StackProps {
  proxyStack: ProxyStack;
}

export class DnsStack extends Stack {
  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    // ─── Route 53 パブリックホストゾーン ─────────────────────
    // your-domain.com のホストゾーンを作成する。
    // ドメイン登録は Route 53 コンソールから手動で行い、
    // 表示される NS レコードをドメイン登録時のネームサーバーとして指定する。
    const zone = new route53.PublicHostedZone(this, "PktcatZone", {
      zoneName: "your-domain.com",
    });

    // ─── minecraft.your-domain.com → プロキシ EIP ─────────────────
    new route53.ARecord(this, "MinecraftARecord", {
      zone,
      recordName: "minecraft",
      target: route53.RecordTarget.fromIpAddresses(props.proxyStack.eipAddress),
      ttl: Duration.seconds(300),
      comment: "Minecraft サーバー (プロキシ EC2 の Elastic IP)",
    });

    // ─── Outputs ──────────────────────────────────────────────
    // ホストゾーンの NS レコードをコンソールに表示する。
    // ドメイン登録後にこれらの NS を Route 53 に設定する。
    new CfnOutput(this, "HostedZoneId", {
      value: zone.hostedZoneId,
      description: "Route 53 ホストゾーン ID",
    });

    new CfnOutput(this, "NameServers", {
      // hostedZoneNameServers はリストトークンなので Fn.join() で結合する
      value: zone.hostedZoneNameServers
        ? Fn.join(", ", zone.hostedZoneNameServers)
        : "(デプロイ後に確認してください)",
      description:
        "NS レコード - your-domain.com のドメイン登録時にこれらを指定してください",
    });

    new CfnOutput(this, "MinecraftEndpoint", {
      value: "minecraft.your-domain.com:25565",
      description: "Minecraft 接続エンドポイント",
    });
  }
}
