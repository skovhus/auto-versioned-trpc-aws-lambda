import type { APIGatewayProxyEvent } from "aws-lambda";
import * as trpc from "@trpc/server";
import { awsLambdaRequestHandler } from "@trpc/server/adapters/aws-lambda";
import type { CreateAWSLambdaContextOptions } from "@trpc/server/adapters/aws-lambda";
import { datadog } from "datadog-lambda-js";
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
    return {
      message: `Greetings from sub router.....`,
    };
  },
});

export const appRouter = trpc
  .router<Context>()
  .query("health", {
    async resolve() {
      console.log("Hello, World!!!!");
      return { success: true };
    },
  })
  .query("greet", {
    async resolve(req) {
      return {
        message: `Greetings! path: ${req.ctx.event.path}.`,
        event: req.ctx.event,
      };
    },
  })
  .query("fail", {
    async resolve(req) {
      throw new Error("boom");
    },
  })
  .merge("sub.", nestedRouter);

export type AppRouter = typeof appRouter;

export const rawHandler = awsLambdaRequestHandler({
  router: appRouter,
  createContext,
  onError: (x) => {
    // TODO: error reporting
    console.log("on error: path=", x.path, "type=", x.type);
  },
});

export const handler = datadog(rawHandler);
