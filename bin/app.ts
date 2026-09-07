#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { CdkS3LambdaProcessorStack } from "../lib/cdk-s3-lambda-processor-stack";
import { resolveAppRegion } from "../lib/region";
import { ENVIRONMENT_TAG, PROJECT_TAG } from "../src/constants";

const app = new cdk.App();
const region = resolveAppRegion(app);

new CdkS3LambdaProcessorStack(app, "CdkS3LambdaProcessor", {
  description:
    "Self-contained demo: S3 incoming/ object-created events invoke Lambda, which writes metadata JSON under processed/. Do not attach this stack to other account resources.",
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  tags: {
    Project: PROJECT_TAG,
    Environment: ENVIRONMENT_TAG,
  },
});
