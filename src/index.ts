import type { APIGatewayProxyEvent } from "aws-lambda";
import type { Context as APIGWContext } from "aws-lambda";
import * as trpc from "@trpc/server";
import { awsLambdaRequestHandler } from "@trpc/server/adapters/aws-lambda";
import type { CreateAWSLambdaContextOptions } from "@trpc/server/adapters/aws-lambda";

export function createContext({
  event,
  context,
}: CreateAWSLambdaContextOptions<APIGatewayProxyEvent>) {
  return {
    event,
    user: event.headers["x-user"],
  };
}
type Context = trpc.inferAsyncReturnType<typeof createContext>;

const nestedRouter = trpc.router<Context>().query("greet", {
  async resolve() {
    return `Greetings from sub router.`;
  },
});

export const appRouter = trpc
  .router<Context>()
  .query("health", {
    async resolve() {
      return { success: true };
    },
  })
  .query("greet", {
    async resolve(req) {
      return `Greetings! path: ${req.ctx.event.path}.`;
    },
  })
  .merge("sub.", nestedRouter);

export type AppRouter = typeof appRouter;

export const baseHandler = awsLambdaRequestHandler({
  router: appRouter,
  createContext,
});

export function handler(event: APIGatewayProxyEvent, context: APIGWContext) {
  // Hack to remove the version from the path
  event.path = "/" + event.path.split("/").slice(2).join("/");
  return baseHandler(event, context);
}
