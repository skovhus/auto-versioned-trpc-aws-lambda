import path from "path";

export const AWS_REGION = process.env.AWS_REGION || "eu-west-1";
export const SERVICE_FUNCTION_NAME = "versioned-trpc";
export const SERVICE_GATEWAY = "versioned-trpc-gateway";
export const SERVICE_LAMBDA_ROLE = "versioned-trpc-lambda-role";
export const SERVICE_GATEWAY_STAGE_NAME = "staging";
export const ROOT_PATH = path.join(__dirname, "../");
