import * as apiGateway from "@aws-sdk/client-api-gateway";
import * as lambda from "@aws-sdk/client-lambda";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { strict as assert } from "node:assert";

import {
  AWS_REGION,
  SERVICE_FUNCTION_NAME,
  SERVICE_GATEWAY_STAGE_NAME,
  ROOT_PATH,
} from "./config";

import * as ApiGatewayService from "./services/api-gateway";
import * as LambdaService from "./services/lambda";

const { lambdaClient } = LambdaService;
const { apiGatewayClient } = ApiGatewayService;

/**
 * Builds and zips the application.
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
 * Deploys the given zip file as a lambda and creates an alias.
 */
async function deployLambda({ zipFilePath }: { zipFilePath: string }): Promise<{
  aliasFunctionName: string;
  aliasArn: string;
}> {
  const contentHash = getHashOfZipFileContent(zipFilePath);
  const aliasFunctionName = contentHash;

  if (await LambdaService.isAliasDeployed(aliasFunctionName)) {
    const restApiId = await ApiGatewayService.getRestApiId();

    const isGatewayDeployed = await ApiGatewayService.isDeployed({
      aliasFunctionName,
      restApiId,
    });

    if (isGatewayDeployed) {
      console.info(
        `Skipping deployment as ${aliasFunctionName} is already deployed ${ApiGatewayService.getUrl(
          {
            aliasFunctionName,
            restApiId,
            stageName: SERVICE_GATEWAY_STAGE_NAME,
          }
        )}`
      );
      process.exit(0);
    }

    // This handles a corner case if the Gateway was not deployed or
    // re-provisioned.
    const { AliasArn: aliasArn } = await lambdaClient.send(
      new lambda.GetAliasCommand({
        FunctionName: SERVICE_FUNCTION_NAME,
        Name: aliasFunctionName,
      })
    );
    assert(aliasArn);

    console.info(
      `Warning: a lambda for ${aliasFunctionName} is already deployed but API Gateway was not updated.`
    );

    return { aliasArn, aliasFunctionName };
  }

  // Update the lambda function
  await lambdaClient.send(
    new lambda.UpdateFunctionCodeCommand({
      FunctionName: SERVICE_FUNCTION_NAME,
      ZipFile: fs.readFileSync(zipFilePath),
    })
  );

  // Wait until it is updated
  const { state: waiterState } = await lambda.waitUntilFunctionUpdated(
    {
      client: lambdaClient,
      maxWaitTime: 30, // seconds
    },
    { FunctionName: SERVICE_FUNCTION_NAME }
  );
  assert(waiterState === "SUCCESS");

  // Publish the new version
  const { Version: FunctionVersion } = await lambdaClient.send(
    new lambda.PublishVersionCommand({
      FunctionName: SERVICE_FUNCTION_NAME,
    })
  );
  assert(FunctionVersion);

  // Create an alias
  const { AliasArn: aliasArn } = await lambdaClient.send(
    new lambda.CreateAliasCommand({
      FunctionName: SERVICE_FUNCTION_NAME,
      Name: aliasFunctionName,
      FunctionVersion,
    })
  );
  assert(aliasArn);

  return { aliasArn, aliasFunctionName };
}

/**
 * Updates the API Gateway with new resources and integrations to expose the given function.
 */
async function updateApiGateway({
  aliasArn,
  aliasFunctionName,
}: {
  aliasArn: string;
  aliasFunctionName: string;
}) {
  const restApiId = await ApiGatewayService.getRestApiId();

  const { proxyResourceId } = await ApiGatewayService.createResources({
    aliasFunctionName,
    restApiId,
  });

  // integrate the lambda function with the proxy resource
  await apiGatewayClient.send(
    new apiGateway.PutIntegrationCommand({
      restApiId,
      resourceId: proxyResourceId,
      httpMethod: "ANY",
      integrationHttpMethod: "POST",
      type: "AWS_PROXY",
      credentials: await LambdaService.getLambdaArnRole(),
      uri: `arn:aws:apigateway:${AWS_REGION}:lambda:path/2015-03-31/functions/${aliasArn}/invocations`,
    })
  );

  const stageName = SERVICE_GATEWAY_STAGE_NAME;
  await ApiGatewayService.deploy({ restApiId, stageName });

  const serviceUrl = ApiGatewayService.getUrl({
    aliasFunctionName,
    restApiId,
    stageName,
  });
  const healthEndpoint = `${serviceUrl}/health`;
  await ApiGatewayService.ensureApiResponds(healthEndpoint);

  console.info(`API is live at ${healthEndpoint}`);
}

const run = async () => {
  const { zipFilePath } = await build();

  const { aliasArn, aliasFunctionName } = await deployLambda({
    zipFilePath,
  });

  await updateApiGateway({ aliasArn, aliasFunctionName });
};

run();
