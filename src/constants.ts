export const INCOMING_PREFIX = "incoming/";
export const PROCESSED_PREFIX = "processed/";

/** Reject downloads and hashing above this size; still write a processed JSON. */
export const MAX_OBJECT_BYTES = 5 * 1024 * 1024;

export const PROJECT_TAG = "cdk-s3-lambda-processor";
export const ENVIRONMENT_TAG = "demo";
