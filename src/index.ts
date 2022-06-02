import * as trpc from "@trpc/server";
import type { CreateLambdaContextOptions } from "./adapters/lambda";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { lambdaRequestHandler } from "./adapters/lambda";
import type { Context as APIGWContext } from "aws-lambda";

export function createContext({
  event,
  context,
}: CreateLambdaContextOptions<APIGatewayProxyEvent>) {
  return {
    event,
    apiVersion: (event as { version?: string }).version || "1.0",
    user: event.headers["x-user"],
  };
}
type Context = trpc.inferAsyncReturnType<typeof createContext>;

const nestedRouter = trpc.router<Context>().query("greet", {
  async resolve(req) {
    return `Greetings from sub.`;
  },
});

export const appRouter = trpc
  .router<Context>()
  .query("greet", {
    async resolve(req) {
      return `Greetings! path: ${req.ctx.event.path}.`;
    },
  })
  .merge("sub.", nestedRouter);

export type AppRouter = typeof appRouter;

export const baseHandler = lambdaRequestHandler({
  router: appRouter,
  createContext,
});

export function handler(event: APIGatewayProxyEvent, context: APIGWContext) {
  // Hack to remove the version from the path
  event.path = "/" + event.path.split("/").slice(2).join("/");
  return baseHandler(event, context);
}
