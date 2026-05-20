#!/usr/bin/env node
import "source-map-support/register";
import { App } from "aws-cdk-lib";
import { SecurityGroupStack } from "../lib/security-group-stack";
import { GameServerStack } from "../lib/game-server-stack";
import { ProxyStack } from "../lib/proxy-stack";
import { MonitoringStack } from "../lib/monitoring-stack";
import { DnsStack } from "../lib/dns-stack";

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: "ap-northeast-1",
};

// ─── 1. セキュリティグループ ──────────────────────────────────
const sgStack = new SecurityGroupStack(app, "MinecraftSgStack", { env });

// ─── 2. ゲームサーバー EC2 ────────────────────────────────────
const gameStack = new GameServerStack(app, "MinecraftGameStack", {
  env,
  sgStack,
});

// ─── 3. プロキシ EC2 ──────────────────────────────────────────
const proxyStack = new ProxyStack(app, "MinecraftProxyStack", {
  env,
  sgStack,
  gameStack,
});

// ─── 4. 自動停止監視 ──────────────────────────────────────────
new MonitoringStack(app, "MinecraftMonitorStack", {
  env,
  gameStack,
});

// ─── 5. DNS (Route 53) ───────────────────────────────────────
new DnsStack(app, "MinecraftDnsStack", {
  env,
  proxyStack,
});
