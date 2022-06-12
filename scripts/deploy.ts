import * as apiGateway from "@aws-sdk/client-api-gateway";
import * as lambda from "@aws-sdk/client-lambda";
import * as iam from "@aws-sdk/client-iam";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { strict as assert } from "node:assert";

const AWS_REGION = process.env.AWS_REGION || "eu-west-1";
const SERVICE_FUNCTION_NAME = "versioned-trpc";
const SERVICE_GATEWAY = "versioned-trpc-gateway";
const SERVICE_LAMBDA_ROLE = "versioned-trpc-lambda-role";
const SERVICE_GATEWAY_STAGE_NAME = "staging";
const ROOT_PATH = path.join(__dirname, "../");

const apiGatewayClient = new apiGateway.APIGatewayClient({
  region: AWS_REGION,
});
const lambdaClient = new lambda.LambdaClient({ region: AWS_REGION });
const iamClient = new iam.IAMClient({ region: AWS_REGION });

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

class Lambda {
  public static async getLambdaArnRole(): Promise<string> {
    const { Role } = await iamClient.send(
      new iam.GetRoleCommand({
        RoleName: SERVICE_LAMBDA_ROLE,
      })
    );
    const lambdaArnRole = Role?.Arn;
    assert(lambdaArnRole);
    return lambdaArnRole;
  }

  public static async isAliasDeployed(
    aliasFunctionName: string
  ): Promise<boolean> {
    try {
      await lambdaClient.send(
        new lambda.GetAliasCommand({
          FunctionName: SERVICE_FUNCTION_NAME,
          Name: aliasFunctionName,
        })
      );

      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        "ResourceNotFoundException" === error.name
      ) {
        return false;
      }

      throw error;
    }
  }
}

class ApiGatewayService {
  public static async getRestApiId() {
    const restApiId = (
      await apiGatewayClient.send(new apiGateway.GetRestApisCommand({}))
    ).items
      ?.filter((i) => i.name === SERVICE_GATEWAY)
      .map((i) => i.id)[0];
    assert(restApiId);
    return restApiId;
  }

  public static async getApiResourceRootId(restApiId: string): Promise<string> {
    // NOTE: GetResourcesCommand doesn't have server side filtering...
    const apiResourceRootId = execSync(
      `aws apigateway get-resources --rest-api-id "${restApiId}" --query "items[?path=='/']" | jq '.[0].id' --raw-output`
    )
      .toString()
      .trim();
    assert(apiResourceRootId);

    return apiResourceRootId;
  }

  /**
   * Returns all the API resources
   */
  private static async getAllApiResources({
    restApiId,
  }: {
    restApiId: string;
  }): Promise<apiGateway.Resource[]> {
    let position = undefined;
    let items: apiGateway.Resource[] = [];
    while (1) {
      const response = await apiGatewayClient.send(
        new apiGateway.GetResourcesCommand({
          restApiId,
          embed: ["methods"],
          limit: 100,
          position,
        })
      );

      items = [...(response.items || []), ...items];

      if (response.position) {
        position = response.position as any;
      } else {
        break;
      }
    }

    return items;
  }

  /**
   * Cleans up all incomplete API resources, that is resources with
   * missing proxy routes or proxy routes without an integration.
   */
  public static async cleanUpIncompleteApiResources({
    restApiId,
  }: {
    restApiId: string;
  }) {
    const resources = await ApiGatewayService.getAllApiResources({ restApiId });

    const functionalResourcesPaths = resources
      .filter(
        (resource) =>
          resource.resourceMethods?.ANY?.methodIntegration !== undefined
      )
      .map((resource) => resource.path!)
      .sort();

    let incompleteResources = resources.filter(
      (resource) =>
        !functionalResourcesPaths.some((path) =>
          path?.startsWith(resource.path!)
        )
    );

    // dedupe nested resources, you can only delete one of them
    const dedupedIncompleteResources = incompleteResources.filter(
      (resource) =>
        resource.pathPart == "{proxy+}" ||
        !incompleteResources.some(
          (otherResources) =>
            otherResources.id != resource.id &&
            otherResources.path!.startsWith(resource.path!)
        )
    );

    for (const resource of dedupedIncompleteResources) {
      console.info(
        `Deleting incomplete resource: ${resource.id} ${resource.path}`
      );
      await apiGatewayClient.send(
        new apiGateway.DeleteResourceCommand({
          restApiId,
          resourceId: resource.id,
        })
      );
    }
  }

  /**
   * Deploy the API Gateway and gracefully handle the case of incomplete API resources.
   */
  public static async deploy({
    restApiId,
    stageName,
  }: {
    restApiId: string;
    stageName: string;
  }) {
    async function deploy() {
      await apiGatewayClient.send(
        new apiGateway.CreateDeploymentCommand({
          restApiId,
          stageName,
        })
      );
    }

    try {
      await deploy();
    } catch (error) {
      if (
        error instanceof Error &&
        "No integration defined for method" === error.message
      ) {
        console.info(
          "Deploy failed due to incomplete API resources, trying to recover..."
        );
        await ApiGatewayService.cleanUpIncompleteApiResources({ restApiId });
        await deploy();
      } else {
        throw error;
      }
    }
  }
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

  if (await Lambda.isAliasDeployed(aliasFunctionName)) {
    console.info(
      `Skipping deployment as ${aliasFunctionName} is already deployed`
    );
    // FIXME: actually we should check if this is also in the API gateway
    // as the deployment process could have crashed before it was deployed.
    process.exit(0);
  }

  await lambdaClient.send(
    new lambda.UpdateFunctionCodeCommand({
      FunctionName: SERVICE_FUNCTION_NAME,
      ZipFile: fs.readFileSync(zipFilePath),
    })
  );

  const { state: waiterState } = await lambda.waitUntilFunctionUpdated(
    {
      client: lambdaClient,
      maxWaitTime: 20,
    },
    { FunctionName: SERVICE_FUNCTION_NAME }
  );
  assert(waiterState === "SUCCESS");

  const { Version: FunctionVersion } = await lambdaClient.send(
    new lambda.PublishVersionCommand({
      FunctionName: SERVICE_FUNCTION_NAME,
    })
  );
  assert(FunctionVersion);

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

  const apiResourceRootId = await ApiGatewayService.getApiResourceRootId(
    restApiId
  );

  // create a resource with the alias function name
  const { id: aliasResourceId } = await apiGatewayClient.send(
    new apiGateway.CreateResourceCommand({
      restApiId,
      parentId: apiResourceRootId,
      pathPart: aliasFunctionName,
    })
  );
  assert(aliasResourceId);

  // create a nested proxy resource
  const { id: proxyResourceId } = await apiGatewayClient.send(
    new apiGateway.CreateResourceCommand({
      restApiId,
      parentId: aliasResourceId,
      pathPart: "{proxy+}",
    })
  );
  assert(proxyResourceId);

  // add a method to the proxy resource path that accepts any HTTP method
  await apiGatewayClient.send(
    new apiGateway.PutMethodCommand({
      restApiId,
      resourceId: proxyResourceId,
      httpMethod: "ANY",
      authorizationType: "NONE",
    })
  );

  // integrate the lambda function with the proxy resource
  await apiGatewayClient.send(
    new apiGateway.PutIntegrationCommand({
      restApiId,
      resourceId: proxyResourceId,
      httpMethod: "ANY",
      integrationHttpMethod: "POST",
      type: "AWS_PROXY",
      credentials: await Lambda.getLambdaArnRole(),
      uri: `arn:aws:apigateway:${AWS_REGION}:lambda:path/2015-03-31/functions/${aliasArn}/invocations`,
    })
  );

  const stageName = SERVICE_GATEWAY_STAGE_NAME;
  await ApiGatewayService.deploy({ restApiId, stageName });

  // TODO: poll until ready (responds with a healthy response) and fail if it isn't ready in x seconds
  console.info(
    `API is live in a few seconds at https://${restApiId}.execute-api.${AWS_REGION}.amazonaws.com/${stageName}/${aliasFunctionName}/greet`
  );
}

const run = async () => {
  const { zipFilePath } = await build();
  const { aliasArn, aliasFunctionName } = await deployLambda({
    zipFilePath,
  });
  await updateApiGateway({ aliasArn, aliasFunctionName });
};

run();
