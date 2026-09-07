#!/usr/bin/env bash
# Retries and skipping IMDS make the CDK CLI watcher less sensitive to brief
# local network drops. CloudFormation is still the source of truth.
set -euo pipefail
export AWS_MAX_ATTEMPTS="${AWS_MAX_ATTEMPTS:-20}"
export AWS_RETRY_MODE="${AWS_RETRY_MODE:-adaptive}"
export AWS_EC2_METADATA_DISABLED="${AWS_EC2_METADATA_DISABLED:-true}"
exec npx --no-install cdk "$@"
