/**
 * Get the deployment configuration (either static or dynamic from environment variables).
 * NOTE: all dynamic configuration needs to be added here to we can properly compute
 * the version number based on this.
 */
export function getConfig() {
  return {
    AWS_REGION: process.env.AWS_REGION || "eu-west-1",
    SERVICE_FUNCTION_NAME: "versioned-trpc",
    SERVICE_LAMBDA_ROLE: "versioned-trpc-lambda-role",
  };
}
