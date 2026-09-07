import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { CdkS3LambdaProcessorStack } from "../lib/cdk-s3-lambda-processor-stack";
import { resolveAppRegion } from "../lib/region";

const TEST_REGION = "eu-west-1";

describe("region resolution", () => {
  const originalDeploy = process.env.CDK_DEPLOY_REGION;
  const originalDefault = process.env.CDK_DEFAULT_REGION;

  afterEach(() => {
    if (originalDeploy === undefined) {
      delete process.env.CDK_DEPLOY_REGION;
    } else {
      process.env.CDK_DEPLOY_REGION = originalDeploy;
    }
    if (originalDefault === undefined) {
      delete process.env.CDK_DEFAULT_REGION;
    } else {
      process.env.CDK_DEFAULT_REGION = originalDefault;
    }
  });

  test("prefers CDK_DEPLOY_REGION over cdk.json context", () => {
    process.env.CDK_DEPLOY_REGION = "ap-southeast-1";
    const app = new App({ context: { region: "us-west-2" } });
    expect(resolveAppRegion(app)).toBe("ap-southeast-1");
  });

  test("uses cdk.json context.region when CDK_DEPLOY_REGION is unset", () => {
    delete process.env.CDK_DEPLOY_REGION;
    const app = new App({ context: { region: "us-west-2" } });
    expect(resolveAppRegion(app)).toBe("us-west-2");
  });

  test("ignores CDK_DEFAULT_REGION so the AWS CLI default cannot win", () => {
    delete process.env.CDK_DEPLOY_REGION;
    process.env.CDK_DEFAULT_REGION = "us-east-1";
    const app = new App({ context: { region: "us-west-2" } });
    expect(resolveAppRegion(app)).toBe("us-west-2");
  });

  test("refuses to run with no region rather than defaulting to us-east-1", () => {
    delete process.env.CDK_DEPLOY_REGION;
    const app = new App({ context: {} });
    expect(() => resolveAppRegion(app)).toThrow(/will not fall back to us-east-1/);
  });
});

describe("CdkS3LambdaProcessor stack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new CdkS3LambdaProcessorStack(app, "CdkS3LambdaProcessor", {
      env: { account: "123456789012", region: TEST_REGION },
    });
    template = Template.fromStack(stack);
  });

  test("names the bucket with account id and the configured region", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: {
        "Fn::Join": [
          "",
          ["cdk-s3-lambda-processor-", { Ref: "AWS::AccountId" }, `-${TEST_REGION}`],
        ],
      },
    });
  });

  test("creates a private bucket with destroy policy, lifecycle, and no public access", () => {
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: Match.arrayWith([
            Match.objectLike({
              ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
            }),
          ]),
        },
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Prefix: "incoming/",
              ExpirationInDays: 7,
              Status: "Enabled",
            }),
            Match.objectLike({
              Prefix: "processed/",
              ExpirationInDays: 7,
              Status: "Enabled",
            }),
          ]),
        },
      },
    });
    expect(template.findResources("Custom::S3AutoDeleteObjects")).not.toEqual({});
  });

  test("processor Lambda is ARM64, 256 MB, 30s, with 7-day log retention", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      MemorySize: 256,
      Timeout: 30,
      Architectures: ["arm64"],
    });

    template.hasResourceProperties("AWS::Logs::LogGroup", {
      RetentionInDays: 7,
    });

    template.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
    });
  });

  test("Lambda may GetObject incoming/* and PutObject processed/* only", () => {
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));

    expect(policies).toContain("s3:GetObject");
    expect(policies).toContain("incoming/*");
    expect(policies).toContain("s3:PutObject");
    expect(policies).toContain("processed/*");
    expect(policies).not.toContain("s3:HeadObject");
    expect(policies).not.toContain("s3:DeleteObject");
    expect(policies).not.toContain("s3:*");
  });

  test("S3 notification is filtered to incoming/ only", () => {
    const notifications = JSON.stringify(
      template.findResources("Custom::S3BucketNotifications"),
    );
    expect(notifications).toContain("s3:ObjectCreated");
    expect(notifications).toContain("incoming/");
    expect(notifications).not.toContain("processed/");
  });

  test("does not create extra product services", () => {
    expect(template.findResources("AWS::DynamoDB::Table")).toEqual({});
    expect(template.findResources("AWS::SQS::Queue")).toEqual({});
    expect(template.findResources("AWS::SNS::Topic")).toEqual({});
    expect(template.findResources("AWS::ApiGateway::RestApi")).toEqual({});
    expect(template.findResources("AWS::ApiGatewayV2::Api")).toEqual({});
    expect(template.findResources("AWS::CloudFront::Distribution")).toEqual({});
    expect(template.findResources("AWS::EC2::VPC")).toEqual({});
    expect(template.findResources("AWS::Lambda::Url")).toEqual({});
    expect(template.findResources("AWS::KMS::Key")).toEqual({});
  });

  test("tags stack resources for the demo project", () => {
    const buckets = template.findResources("AWS::S3::Bucket");
    const bucket = Object.values(buckets)[0] as {
      Properties?: { Tags?: { Key: string; Value: string }[] };
    };
    const tags = (bucket.Properties?.Tags ?? []).map((tag) => `${tag.Key}=${tag.Value}`);
    expect(tags).toEqual(
      expect.arrayContaining([
        "Project=cdk-s3-lambda-processor",
        "Environment=demo",
      ]),
    );
  });

  test("Lambda bundle requires the runtime AWS SDK instead of shipping a copy", () => {
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "cdk-s3-lambda-processor-"));
    const app = new App({ outdir });
    new CdkS3LambdaProcessorStack(app, "CdkS3LambdaProcessor", {
      env: { account: "123456789012", region: TEST_REGION },
    });
    app.synth();

    const indexes = fs
      .readdirSync(outdir)
      .filter((name) => name.startsWith("asset."))
      .map((name) => path.join(outdir, name, "index.js"))
      .filter((file) => fs.existsSync(file));
    const processorBundle = indexes.find((file) =>
      fs.readFileSync(file, "utf8").includes("incoming/"),
    );
    expect(processorBundle).toBeDefined();

    const source = fs.readFileSync(processorBundle!, "utf8");
    expect(source).toMatch(/require\(["']@aws-sdk\/client-s3["']\)/);
    expect(source).not.toMatch(/@aws-sdk\/middleware-sdk-s3/);
    expect(source).not.toMatch(/class GetObjectCommand/);
  });
});
