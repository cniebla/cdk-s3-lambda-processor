#!/usr/bin/env bash
# Empty the demo bucket (auto-delete objects) and remove CdkS3LambdaProcessor.
# Safe to re-run if the CDK CLI watcher drops on a flaky network: CloudFormation
# status is the source of truth, not the progress bar.
set -euo pipefail
cd "$(dirname "$0")/.."

export AWS_MAX_ATTEMPTS="${AWS_MAX_ATTEMPTS:-20}"
export AWS_RETRY_MODE="${AWS_RETRY_MODE:-adaptive}"
export AWS_EC2_METADATA_DISABLED="${AWS_EC2_METADATA_DISABLED:-true}"

STACK="${STACK_NAME:-CdkS3LambdaProcessor}"
REGION="${CDK_DEPLOY_REGION:-}"
if [[ -z "$REGION" ]]; then
  REGION="$(node -e 'const c=require("./cdk.json"); const r=c.context && c.context.region; process.stdout.write(typeof r==="string"?r.trim():"")')"
fi
if [[ -z "$REGION" ]]; then
  echo "error: set CDK_DEPLOY_REGION or cdk.json context.region before destroy." >&2
  exit 1
fi
export CDK_DEPLOY_REGION="$REGION"

stack_status() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK" \
    --region "$REGION" \
    --query "Stacks[0].StackStatus" \
    --output text 2>/dev/null || true
}

status="$(stack_status)"
if [[ -z "$status" || "$status" == "None" ]]; then
  echo "Stack $STACK is not present in $REGION. Nothing to destroy."
  exit 0
fi

echo "Destroying $STACK in $REGION (status: $status)."
echo "Objects under the demo bucket are deleted first (RemovalPolicy.DESTROY + autoDeleteObjects)."

set +e
npx --no-install cdk destroy "$STACK" --force "$@"
cdk_rc=$?
set -e

for _ in $(seq 1 80); do
  status="$(stack_status)"
  if [[ -z "$status" || "$status" == "None" || "$status" == "DELETE_COMPLETE" ]]; then
    echo "Stack $STACK is gone from $REGION."
    exit 0
  fi
  case "$status" in
    DELETE_FAILED|ROLLBACK_FAILED)
      echo "error: $STACK ended in $status" >&2
      aws cloudformation describe-stack-events \
        --stack-name "$STACK" \
        --region "$REGION" \
        --query "StackEvents[?contains(ResourceStatus, \`FAILED\`)].[LogicalResourceId,ResourceStatus,ResourceStatusReason]" \
        --output table >&2 || true
      exit 1
      ;;
    DELETE_IN_PROGRESS)
      sleep 15
      ;;
    *)
      if [[ "$cdk_rc" -ne 0 ]]; then
        echo "CDK CLI exited $cdk_rc; CloudFormation status is $status. Waiting..."
      fi
      sleep 15
      ;;
  esac
done

echo "error: timed out waiting for $STACK to delete (last status: ${status:-unknown})" >&2
exit 1
