import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { strict as assert } from "node:assert";

import * as lambda from "@aws-sdk/client-lambda";
import * as iam from "@aws-sdk/client-iam";

const AWS_REGION = process.env.AWS_REGION || "eu-west-1";
const SERVICE_FUNCTION_NAME = "versioned-trpc";
const SERVICE_LAMBDA_ROLE = "versioned-trpc-lambda-role";
const ROOT_PATH = path.join(__dirname, "../");

const lambdaClient = new lambda.LambdaClient({ region: AWS_REGION });
const iamClient = new iam.IAMClient({ region: AWS_REGION });

async function ensureApiResponds(url: string) {
  const tStart = new Date().getTime();
  execSync(`
    curl --connect-timeout 5 \
      --max-time 5 \
      --retry 5 \
      --retry-delay 0 \
      --silent \
      '${url}'`);
  console.log(`Endpoint responded after ${new Date().getTime() - tStart}ms`);
}

async function getLambdaArnRole(): Promise<string> {
  const { Role } = await iamClient.send(
    new iam.GetRoleCommand({
      RoleName: SERVICE_LAMBDA_ROLE,
    })
  );
  const lambdaArnRole = Role?.Arn;
  assert(lambdaArnRole);
  return lambdaArnRole;
}

/**
 * Builds and zips the application.
 * Should likely done before running this script.
 */
async function build(): Promise<{ zipFilePath: string }> {
  const handlerZipPath = "dist/handler.zip";

  execSync(
    "yarn esbuild --bundle src/index.ts --outdir=dist --minify --platform=node",
    { cwd: ROOT_PATH }
  );

  execSync(`zip ${handlerZipPath} dist/index.js`, { cwd: ROOT_PATH });

  return { zipFilePath: path.join(ROOT_PATH, handlerZipPath) };
}

/**
 * Compute the has of the zip file content.
 */
function getHashOfZipFileContent(zipFilePath: string) {
  const tmpPath = fs.mkdtempSync(os.tmpdir());

  execSync(`unzip ${zipFilePath} -d ${tmpPath}`, { cwd: ROOT_PATH });

  return execSync(
    `find ${tmpPath} -type f -print0 | sort -z | xargs -0 shasum | awk '{ print $1 }' | shasum`
  )
    .toString()
    .trim()
    .substring(0, 10);
}

/**
 * Deploys the given zip file as a new lambda with a public function.
 */
async function deployLambda({ zipFilePath }: { zipFilePath: string }) {
  const contentHash = getHashOfZipFileContent(zipFilePath);
  const FunctionName = `${SERVICE_FUNCTION_NAME}-${contentHash}`;

  // Check if the lambda and Function URL is already deployed
  try {
    const { FunctionUrl } = await lambdaClient.send(
      new lambda.GetFunctionUrlConfigCommand({
        FunctionName,
      })
    );
    assert(FunctionUrl);
    console.log(
      `Skipping deployment as this is already live at ${FunctionUrl}`
    );
    process.exit(0);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      "ResourceNotFoundException" !== error.name
    ) {
      throw error;
    }
  }

  // FIXME: handle the case where the function and permissions are created
  // but the Function URL isn't.

  // Create a new lambda function
  // TODO: we could use aliases if we don't like to create a new lambda function.
  await lambdaClient.send(
    new lambda.CreateFunctionCommand({
      FunctionName,
      Role: await getLambdaArnRole(),
      Runtime: lambda.Runtime.nodejs16x,
      Handler: "dist/index.handler",
      Code: {
        ZipFile: fs.readFileSync(zipFilePath),
      },
    })
  );

  // Wait until the lambda is created
  // TODO: not sure if this is strictly required
  const { state: waiterState } = await lambda.waitUntilFunctionUpdated(
    {
      client: lambdaClient,
      maxWaitTime: 30, // seconds
    },
    { FunctionName }
  );
  assert(waiterState === "SUCCESS");

  // Add required permissions for public usage of the function
  await lambdaClient.send(
    new lambda.AddPermissionCommand({
      FunctionName,
      Action: "lambda:InvokeFunctionUrl",
      StatementId: "FunctionURLAllowPublicAccess",
      Principal: "*",
      FunctionUrlAuthType: "NONE",
    })
  );

  // Create a Function URL
  const { FunctionUrl } = await lambdaClient.send(
    new lambda.CreateFunctionUrlConfigCommand({
      FunctionName,
      AuthType: "NONE",
    })
  );
  assert(FunctionUrl);

  await ensureApiResponds(FunctionUrl);

  console.info(`🎄 Deployed at ${FunctionUrl}`);
}

const run = async () => {
  const { zipFilePath } = await build();

  await deployLambda({
    zipFilePath,
  });
};

run();
