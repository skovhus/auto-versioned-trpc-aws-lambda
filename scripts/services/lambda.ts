import { strict as assert } from "node:assert";
import * as lambda from "@aws-sdk/client-lambda";
import * as iam from "@aws-sdk/client-iam";

import {
  AWS_REGION,
  SERVICE_FUNCTION_NAME,
  SERVICE_LAMBDA_ROLE,
} from "../config";

export const lambdaClient = new lambda.LambdaClient({ region: AWS_REGION });
const iamClient = new iam.IAMClient({ region: AWS_REGION });

export async function getLambdaArnRole(): Promise<string> {
  const { Role } = await iamClient.send(
    new iam.GetRoleCommand({
      RoleName: SERVICE_LAMBDA_ROLE,
    })
  );
  const lambdaArnRole = Role?.Arn;
  assert(lambdaArnRole);
  return lambdaArnRole;
}

export async function isAliasDeployed(
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
    if (error instanceof Error && "ResourceNotFoundException" === error.name) {
      return false;
    }

    throw error;
  }
}
