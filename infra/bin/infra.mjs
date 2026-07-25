#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { ScubaSwapStack } from "../lib/scubaswap-stack.mjs";

const app = new App();

// us-east-1 is HARDCODED, not defaulted. CloudFront only accepts an ACM
// certificate from us-east-1, and deferring to CDK_DEFAULT_REGION means whatever
// region happens to be in the deployer's AWS profile silently decides whether
// TLS works. Override deliberately with `-c region=...` if you know why.
const region = app.node.tryGetContext("region") ?? "us-east-1";

new ScubaSwapStack(app, "ScubaSwapStack", {
  env: { region, account: process.env.CDK_DEFAULT_ACCOUNT },
  description: "ScubaSwap SPA + World ID RP signing endpoint",
});
