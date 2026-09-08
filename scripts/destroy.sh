#!/usr/bin/env bash
# Remove CdkS3LambdaProcessor and leftovers CloudFormation does not own:
# CDK custom-resource Lambda log groups, a leftover demo bucket, and (by
# default) unused CDK bootstrap in this region. The CDKToolkit staging
# bucket uses DeletionPolicy: Retain, so deleting the app stack alone
# leaves cdk-hnb659fds-assets-<account>-<region> behind.
#
# Safe to re-run. CloudFormation status is the source of truth, not the
# CDK progress bar. Pass --keep-bootstrap (or KEEP_BOOTSTRAP=1) to leave
# CDKToolkit in place for other apps in the same region.
set -euo pipefail
cd "$(dirname "$0")/.."

export AWS_MAX_ATTEMPTS="${AWS_MAX_ATTEMPTS:-20}"
export AWS_RETRY_MODE="${AWS_RETRY_MODE:-adaptive}"
export AWS_EC2_METADATA_DISABLED="${AWS_EC2_METADATA_DISABLED:-true}"

STACK="${STACK_NAME:-CdkS3LambdaProcessor}"
BOOTSTRAP_STACK="${CDK_BOOTSTRAP_STACK_NAME:-CDKToolkit}"
BOOTSTRAP_QUALIFIER="${CDK_BOOTSTRAP_QUALIFIER:-hnb659fds}"
KEEP_BOOTSTRAP="${KEEP_BOOTSTRAP:-0}"
CDK_DESTROY_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --keep-bootstrap)
      KEEP_BOOTSTRAP=1
      ;;
    --destroy-bootstrap)
      KEEP_BOOTSTRAP=0
      ;;
    *)
      CDK_DESTROY_ARGS+=("$arg")
      ;;
  esac
done

REGION="${CDK_DEPLOY_REGION:-}"
if [[ -z "$REGION" ]]; then
  REGION="$(node -e 'const c=require("./cdk.json"); const r=c.context && c.context.region; process.stdout.write(typeof r==="string"?r.trim():"")')"
fi
if [[ -z "$REGION" ]]; then
  echo "error: set CDK_DEPLOY_REGION or cdk.json context.region before destroy." >&2
  exit 1
fi
export CDK_DEPLOY_REGION="$REGION"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
DEMO_BUCKET="cdk-s3-lambda-processor-${ACCOUNT}-${REGION}"
BOOTSTRAP_BUCKET="cdk-${BOOTSTRAP_QUALIFIER}-assets-${ACCOUNT}-${REGION}"
BOOTSTRAP_ECR="cdk-${BOOTSTRAP_QUALIFIER}-container-assets-${ACCOUNT}-${REGION}"

LIVE_STACK_FILTER=(
  CREATE_IN_PROGRESS CREATE_FAILED CREATE_COMPLETE
  ROLLBACK_IN_PROGRESS ROLLBACK_FAILED ROLLBACK_COMPLETE
  DELETE_FAILED DELETE_IN_PROGRESS
  UPDATE_IN_PROGRESS UPDATE_FAILED UPDATE_COMPLETE
  UPDATE_COMPLETE_CLEANUP_IN_PROGRESS
  UPDATE_ROLLBACK_IN_PROGRESS UPDATE_ROLLBACK_FAILED UPDATE_ROLLBACK_COMPLETE
  UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS
  REVIEW_IN_PROGRESS
  IMPORT_IN_PROGRESS IMPORT_COMPLETE
  IMPORT_ROLLBACK_IN_PROGRESS IMPORT_ROLLBACK_FAILED IMPORT_ROLLBACK_COMPLETE
)

stack_status() {
  local name="$1"
  aws cloudformation describe-stacks \
    --stack-name "$name" \
    --region "$REGION" \
    --query "Stacks[0].StackStatus" \
    --output text 2>/dev/null || true
}

stack_output() {
  local name="$1"
  local key="$2"
  aws cloudformation describe-stacks \
    --stack-name "$name" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey==\`${key}\`].OutputValue" \
    --output text 2>/dev/null || true
}

live_stack_names() {
  aws cloudformation list-stacks \
    --region "$REGION" \
    --stack-status-filter "${LIVE_STACK_FILTER[@]}" \
    --query "StackSummaries[].StackName" \
    --output text 2>/dev/null || true
}

wait_stack_absent() {
  local name="$1"
  local last=""
  local i
  for i in $(seq 1 80); do
    last="$(stack_status "$name")"
    if [[ -z "$last" || "$last" == "None" || "$last" == "DELETE_COMPLETE" ]]; then
      echo "Stack $name is gone from $REGION."
      return 0
    fi
    case "$last" in
      DELETE_FAILED|ROLLBACK_FAILED)
        echo "error: $name ended in $last" >&2
        aws cloudformation describe-stack-events \
          --stack-name "$name" \
          --region "$REGION" \
          --query "StackEvents[?contains(ResourceStatus, \`FAILED\`)].[LogicalResourceId,ResourceStatus,ResourceStatusReason]" \
          --output table >&2 || true
        return 1
        ;;
      DELETE_IN_PROGRESS)
        sleep 15
        ;;
      *)
        sleep 15
        ;;
    esac
  done
  echo "error: timed out waiting for $name to delete (last status: ${last:-unknown})" >&2
  return 1
}

s3_bucket_exists() {
  local bucket="$1"
  aws s3api head-bucket --bucket "$bucket" --region "$REGION" >/dev/null 2>&1
}

empty_s3_bucket() {
  local bucket="$1"
  if ! s3_bucket_exists "$bucket"; then
    return 0
  fi

  echo "Emptying s3://$bucket (including object versions)."
  # Versioned bootstrap buckets cannot be removed with `aws s3 rm`; delete
  # every version and delete marker. Node avoids JMESPath concat differences
  # across AWS CLI versions.
  node -e '
    const { execFileSync } = require("node:child_process");
    const bucket = process.argv[1];
    const region = process.argv[2];
    const aws = (args) => execFileSync("aws", args, { encoding: "utf8" });
    while (true) {
      const data = JSON.parse(aws([
        "s3api", "list-object-versions",
        "--bucket", bucket,
        "--region", region,
        "--max-keys", "1000",
        "--output", "json",
      ]) || "{}");
      const objects = [...(data.Versions || []), ...(data.DeleteMarkers || [])]
        .map((entry) => ({ Key: entry.Key, VersionId: entry.VersionId }));
      if (objects.length === 0) {
        break;
      }
      const result = JSON.parse(aws([
        "s3api", "delete-objects",
        "--bucket", bucket,
        "--region", region,
        "--delete", JSON.stringify({ Objects: objects, Quiet: true }),
      ]) || "{}");
      if ((result.Errors || []).length > 0) {
        console.error(JSON.stringify(result.Errors, null, 2));
        process.exit(1);
      }
    }
  ' "$bucket" "$REGION"
}

delete_s3_bucket() {
  local bucket="$1"
  if ! s3_bucket_exists "$bucket"; then
    return 0
  fi
  empty_s3_bucket "$bucket"
  echo "Deleting s3://$bucket."
  aws s3api delete-bucket --bucket "$bucket" --region "$REGION"
}

delete_log_groups_with_prefix() {
  local prefix="$1"
  local names
  names="$(aws logs describe-log-groups \
    --region "$REGION" \
    --log-group-name-prefix "$prefix" \
    --query "logGroups[].logGroupName" \
    --output text 2>/dev/null || true)"
  if [[ -z "$names" || "$names" == "None" ]]; then
    return 0
  fi
  local name
  for name in $names; do
    echo "Deleting leftover log group $name."
    aws logs delete-log-group --log-group-name "$name" --region "$REGION"
  done
}

empty_ecr_repo() {
  local repo="$1"
  if ! aws ecr describe-repositories \
    --repository-names "$repo" \
    --region "$REGION" >/dev/null 2>&1; then
    return 0
  fi
  local images
  images="$(aws ecr list-images \
    --repository-name "$repo" \
    --region "$REGION" \
    --query "imageIds" \
    --output json)"
  if [[ -n "$images" && "$images" != "[]" && "$images" != "null" ]]; then
    echo "Deleting images in ECR repository $repo."
    aws ecr batch-delete-image \
      --repository-name "$repo" \
      --region "$REGION" \
      --image-ids "$images" >/dev/null
  fi
}

delete_ecr_repo() {
  local repo="$1"
  if ! aws ecr describe-repositories \
    --repository-names "$repo" \
    --region "$REGION" >/dev/null 2>&1; then
    return 0
  fi
  empty_ecr_repo "$repo"
  echo "Deleting leftover ECR repository $repo."
  aws ecr delete-repository --repository-name "$repo" --region "$REGION" --force >/dev/null
}

destroy_app_stack() {
  local status
  status="$(stack_status "$STACK")"
  if [[ -z "$status" || "$status" == "None" ]]; then
    echo "Stack $STACK is not present in $REGION."
    return 0
  fi

  echo "Destroying $STACK in $REGION (status: $status)."
  echo "Objects under the demo bucket are deleted first (RemovalPolicy.DESTROY + autoDeleteObjects)."

  local cdk_rc=0
  set +e
  npx --no-install cdk destroy "$STACK" --force "${CDK_DESTROY_ARGS[@]+"${CDK_DESTROY_ARGS[@]}"}"
  cdk_rc=$?
  set -e

  if [[ "$cdk_rc" -ne 0 ]]; then
    echo "CDK CLI exited $cdk_rc; CloudFormation status is the source of truth."
  fi
  wait_stack_absent "$STACK"
}

cleanup_app_leftovers() {
  # CDK custom-resource Lambdas (S3 notifications + auto-delete objects) create
  # /aws/lambda/<stack>-* log groups that are not in the CloudFormation stack.
  delete_log_groups_with_prefix "/aws/lambda/${STACK}"
  delete_s3_bucket "$DEMO_BUCKET"
}

destroy_bootstrap() {
  if [[ "$KEEP_BOOTSTRAP" != "0" ]]; then
    echo "Keeping CDK bootstrap in $REGION (--keep-bootstrap / KEEP_BOOTSTRAP=1)."
    return 0
  fi

  local others=()
  local name
  for name in $(live_stack_names); do
    if [[ "$name" != "$STACK" && "$name" != "$BOOTSTRAP_STACK" ]]; then
      others+=("$name")
    fi
  done
  if [[ "${#others[@]}" -gt 0 ]]; then
    echo "Keeping $BOOTSTRAP_STACK; other stacks still exist in $REGION: ${others[*]}"
    echo "Re-run with no other stacks, or delete $BOOTSTRAP_STACK yourself if you intend to remove CDK tooling for this region."
    return 0
  fi

  local status
  status="$(stack_status "$BOOTSTRAP_STACK")"
  local bucket="$BOOTSTRAP_BUCKET"
  local ecr="$BOOTSTRAP_ECR"

  if [[ -n "$status" && "$status" != "None" ]]; then
    local from_stack
    from_stack="$(stack_output "$BOOTSTRAP_STACK" BucketName)"
    if [[ -n "$from_stack" && "$from_stack" != "None" ]]; then
      bucket="$from_stack"
    fi
    from_stack="$(stack_output "$BOOTSTRAP_STACK" ImageRepositoryName)"
    if [[ -n "$from_stack" && "$from_stack" != "None" ]]; then
      ecr="$from_stack"
    fi

    echo "Removing unused CDK bootstrap $BOOTSTRAP_STACK in $REGION (status: $status)."
    empty_s3_bucket "$bucket"
    empty_ecr_repo "$ecr"
    aws cloudformation delete-stack --stack-name "$BOOTSTRAP_STACK" --region "$REGION"
    wait_stack_absent "$BOOTSTRAP_STACK"
  else
    echo "Stack $BOOTSTRAP_STACK is not present in $REGION."
  fi

  # StagingBucket DeletionPolicy is Retain; delete it after the stack is gone.
  delete_s3_bucket "$bucket"
  delete_ecr_repo "$ecr"
}

destroy_app_stack
cleanup_app_leftovers
destroy_bootstrap

echo "Destroy finished for $STACK in $REGION."
