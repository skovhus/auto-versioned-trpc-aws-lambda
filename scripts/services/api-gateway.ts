import { execSync } from "child_process";
import { strict as assert } from "node:assert";
import * as apiGateway from "@aws-sdk/client-api-gateway";

import { AWS_REGION, SERVICE_GATEWAY } from "../config";

export const apiGatewayClient = new apiGateway.APIGatewayClient({
  region: AWS_REGION,
});

/**
 * Get the ID of the service.
 */
export async function getRestApiId() {
  const restApiId = (
    await apiGatewayClient.send(new apiGateway.GetRestApisCommand({}))
  ).items
    ?.filter((i) => i.name === SERVICE_GATEWAY)
    .map((i) => i.id)[0];
  assert(restApiId);
  return restApiId;
}

/**
 * Create resources to match /${aliasFunctionName}/{proxy+}
 */
export async function createResources({
  aliasFunctionName,
  restApiId,
}: {
  aliasFunctionName: string;
  restApiId: string;
}): Promise<{ proxyResourceId: string }> {
  const apiResourceRootId = await getApiResourceRootId(restApiId);

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

  return { proxyResourceId };
}

/**
 * Deploy the API Gateway and gracefully handle the case of incomplete API resources.
 */
export async function deploy({
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
      await cleanUpIncompleteApiResources({ restApiId });
      await deploy();
    } else {
      throw error;
    }
  }
}

async function getApiResourceRootId(restApiId: string): Promise<string> {
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
async function getAllApiResources({
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
async function cleanUpIncompleteApiResources({
  restApiId,
}: {
  restApiId: string;
}) {
  const resources = await getAllApiResources({ restApiId });

  const functionalResourcesPaths = resources
    .filter(
      (resource) =>
        resource.resourceMethods?.ANY?.methodIntegration !== undefined
    )
    .map((resource) => resource.path!)
    .sort();

  let incompleteResources = resources.filter(
    (resource) =>
      !functionalResourcesPaths.some((path) => path?.startsWith(resource.path!))
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
