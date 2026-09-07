/**
 * Deployment region is explicit. CDK_DEFAULT_REGION is ignored because the
 * CDK CLI fills it from the AWS config default (often us-east-1).
 *
 * Order: CDK_DEPLOY_REGION, then cdk.json context.region. No silent fallback.
 */
export function resolveAppRegion(app: {
  node: { tryGetContext(key: string): unknown };
}): string {
  const fromEnv = process.env.CDK_DEPLOY_REGION?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const fromContext = app.node.tryGetContext("region");
  if (typeof fromContext === "string" && fromContext.trim().length > 0) {
    return fromContext.trim();
  }

  throw new Error(
    'Set a deployment region with CDK_DEPLOY_REGION or cdk.json context "region". This app does not use the AWS CLI default region (and will not fall back to us-east-1).',
  );
}
