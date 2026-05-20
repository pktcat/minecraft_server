import * as path from "path";
import { Duration, Stack, StackProps } from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { GameServerStack } from "./game-server-stack";

interface MonitoringStackProps extends StackProps {
  gameStack: GameServerStack;
}

export class MonitoringStack extends Stack {
  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const gameInstanceId = props.gameStack.instance.instanceId;

    // ─── Lambda 関数 ──────────────────────────────────────────
    const shutdownFn = new lambda.Function(this, "AutoShutdown", {
      functionName: "minecraft-auto-shutdown",
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "index.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../lambda/auto-shutdown")
      ),
      environment: {
        GAME_INSTANCE_ID: gameInstanceId,
        // AWS_REGION は Lambda ランタイムが自動で設定するため不要
      },
      timeout: Duration.seconds(30),
      description: "Minecraft サーバーをプレイヤー不在 30 分で自動停止する",
    });

    // ─── Lambda IAM 権限 ──────────────────────────────────────
    // StopInstances はゲームサーバーのみ
    shutdownFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:StopInstances"],
        resources: [
          `arn:aws:ec2:${this.region}:${this.account}:instance/${gameInstanceId}`,
        ],
      })
    );

    // DescribeInstances は resource 制限不可
    shutdownFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeInstances", "ec2:DescribeInstanceStatus"],
        resources: ["*"],
      })
    );

    // SSM Parameter Store の読み書き
    shutdownFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/*`,
        ],
      })
    );

    // ─── EventBridge Rule (5 分おき) ─────────────────────────
    new events.Rule(this, "AutoShutdownSchedule", {
      ruleName: "minecraft-auto-shutdown-schedule",
      description: "Minecraft サーバーのプレイヤー数を 5 分おきに確認する",
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(shutdownFn)],
    });
  }
}
