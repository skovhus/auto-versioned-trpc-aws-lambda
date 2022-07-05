import { execSync } from "child_process";
import fs from "fs";
import { strict as assert } from "node:assert";

import * as lambda from "@aws-sdk/client-lambda";
import * as iam from "@aws-sdk/client-iam";

import { build } from "./build";
import { getConfig } from "./config";
import { computeVersion } from "./versioning";

const {
  AWS_REGION,
  SERVICE_FUNCTION_NAME,
  SERVICE_LAMBDA_ROLE,
  LAMBDA_MEMORY_SIZE,
  LAMBDA_TIMEOUT,
} = getConfig();

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
      --show-error \
      --fail \
      '${url}health'
  `);
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
 * Deploys the given zip file as a new lambda with a public function.
 */
async function deployLambda({ zipFilePath }: { zipFilePath: string }) {
  const version = computeVersion({ lambdaZipFilePath: zipFilePath });

  const FunctionName = `${SERVICE_FUNCTION_NAME}-${version}`;

  // Check if the lambda and Function URL is already deployed
  try {
    const { FunctionUrl } = await lambdaClient.send(
      new lambda.GetFunctionUrlConfigCommand({
        FunctionName,
      })
    );
    assert(FunctionUrl);
    console.info(
      `🏝 Skipping deployment as ${FunctionName} is already live at ${FunctionUrl}`
    );
    process.exit(0);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      "ResourceNotFoundException" !== error.name
    ) {
      // Unexpected error
      throw error;
    }
  }

  const DD_API_KEY = process.env.DD_API_KEY;
  assert(DD_API_KEY);

  try {
    // Create a new lambda function
    // NOTE: we could use aliases if we don't like to create a new lambda function.
    await lambdaClient.send(
      new lambda.CreateFunctionCommand({
        FunctionName,
        Role: await getLambdaArnRole(),
        Runtime: lambda.Runtime.nodejs16x,
        Handler: "dist/node_modules/datadog-lambda-js/dist/handler.handler",
        Code: {
          ZipFile: fs.readFileSync(zipFilePath),
        },
        Layers: [
          `arn:aws:lambda:${AWS_REGION}:464622532012:layer:Datadog-Extension:23`,
        ],
        Environment: {
          Variables: {
            DD_LAMBDA_HANDLER: "dist/index.handler",
            DD_API_KEY,
            DD_SITE: "datadoghq.eu",
            DD_VERSION: version,
            DD_ENV: "staging",
            DD_SERVICE: "trpc",
            DD_LOG_LEVEL: "info",
            // TODO: figure out how to pass in runtime variables
          },
        },
        MemorySize: LAMBDA_MEMORY_SIZE,
        Timeout: LAMBDA_TIMEOUT,
      })
    );

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
  } catch (error) {
    const leftoverDeployment =
      error instanceof Error && "ResourceConflictException" === error.name;

    if (leftoverDeployment) {
      console.warn(
        `Trying to clean up from an unfinished deploy. ${error.message}`
      );
      await lambdaClient.send(
        new lambda.DeleteFunctionCommand({ FunctionName })
      );
      console.info(
        "Successfully cleaned up after a previous deploy... Please rerun the deploy"
      );
      process.exit(2);
    }

    throw error;
  }
}

const run = async () => {
  const { zipFilePath } = await build();

  await deployLambda({
    zipFilePath,
  });
};

run();
