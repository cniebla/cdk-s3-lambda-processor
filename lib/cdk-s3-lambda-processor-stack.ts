import * as path from "node:path";
import {
  Aws,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
} from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { S3EventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import {
  ENVIRONMENT_TAG,
  INCOMING_PREFIX,
  PROCESSED_PREFIX,
  PROJECT_TAG,
} from "../src/constants";

export class CdkS3LambdaProcessorStack extends Stack {
  public readonly bucket: s3.Bucket;
  public readonly processor: NodejsFunction;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    Tags.of(this).add("Project", PROJECT_TAG);
    Tags.of(this).add("Environment", ENVIRONMENT_TAG);

    this.bucket = new s3.Bucket(this, "ProcessorBucket", {
      bucketName: `cdk-s3-lambda-processor-${Aws.ACCOUNT_ID}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      publicReadAccess: false,
      versioned: false,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          id: "ExpireIncomingAfter7Days",
          prefix: INCOMING_PREFIX,
          expiration: Duration.days(7),
        },
        {
          id: "ExpireProcessedAfter7Days",
          prefix: PROCESSED_PREFIX,
          expiration: Duration.days(7),
        },
      ],
    });

    const logGroup = new logs.LogGroup(this, "ProcessorLogGroup", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.processor = new NodejsFunction(this, "ProcessorFunction", {
      description:
        "Reads incoming/ images from this stack's bucket and writes metadata JSON under processed/.",
      entry: path.join(__dirname, "..", "src", "handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      logGroup,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20",
        format: OutputFormat.CJS,
      },
    });

    this.processor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadIncomingObjects",
        actions: ["s3:GetObject"],
        resources: [this.bucket.arnForObjects(`${INCOMING_PREFIX}*`)],
      }),
    );
    this.processor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "WriteProcessedSidecars",
        actions: ["s3:PutObject"],
        resources: [this.bucket.arnForObjects(`${PROCESSED_PREFIX}*`)],
      }),
    );

    this.processor.addEventSource(
      new S3EventSource(this.bucket, {
        events: [s3.EventType.OBJECT_CREATED],
        filters: [{ prefix: INCOMING_PREFIX }],
      }),
    );

    new CfnOutput(this, "BucketName", {
      value: this.bucket.bucketName,
      description: "Bucket created by this stack (not an existing account bucket).",
    });
    new CfnOutput(this, "FunctionName", {
      value: this.processor.functionName,
    });
    new CfnOutput(this, "Region", {
      value: this.region,
    });
    new CfnOutput(this, "IncomingPrefix", {
      value: INCOMING_PREFIX,
    });
    new CfnOutput(this, "ProcessedPrefix", {
      value: PROCESSED_PREFIX,
    });
  }
}
