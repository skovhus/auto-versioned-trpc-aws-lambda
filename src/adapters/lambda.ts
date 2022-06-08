import {
  AnyRouter,
  inferRouterContext,
  resolveHTTPResponse,
  TRPCError,
} from "@trpc/server";
import {
  HTTPHeaders,
  HTTPRequest,
  HTTPResponse,
} from "@trpc/server/dist/declarations/src/http/internals/types";
import type {
  Context as APIGWContext,
  APIGatewayProxyEvent,
  APIGatewayProxyEventV2,
  APIGatewayProxyResult,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import {
  APIGatewayEvent,
  APIGatewayResult,
  AWSLambdaOptions,
  UNKNOWN_PAYLOAD_FORMAT_VERSION_ERROR_MESSAGE,
  isPayloadV1,
  isPayloadV2,
} from "./utils";

export type { CreateLambdaContextOptions, AWSLambdaOptions } from "./utils";

function lambdaEventToHTTPRequest(event: APIGatewayEvent): HTTPRequest {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(
    event.queryStringParameters ?? {}
  )) {
    if (typeof value !== "undefined") {
      query.append(key, value as any);
    }
  }

  return {
    method: getHTTPMethod(event),
    query: query,
    headers: event.headers,
    body: event.body,
  };
}

function getHTTPMethod(event: APIGatewayEvent) {
  if (isPayloadV1(event)) {
    return event.httpMethod;
  } else if (isPayloadV2(event)) {
    return event.requestContext.http.method;
  } else {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: UNKNOWN_PAYLOAD_FORMAT_VERSION_ERROR_MESSAGE,
    });
  }
}
function getPath(event: APIGatewayEvent) {
  if (isPayloadV1(event)) {
    return event.path.slice(1);
  } else if (isPayloadV2(event)) {
    return event.rawPath.slice(1);
  } else {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: UNKNOWN_PAYLOAD_FORMAT_VERSION_ERROR_MESSAGE,
    });
  }
}
function transformHeaders(headers: HTTPHeaders): APIGatewayResult["headers"] {
  const obj: APIGatewayResult["headers"] = {};

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "undefined") {
      continue;
    }
    obj[key] = Array.isArray(value) ? value.join(",") : value;
  }
  return obj;
}
function tRPCOutputToAPIGatewayOutput<
  TEvent extends APIGatewayEvent,
  TResult extends APIGatewayResult
>(event: TEvent, response: HTTPResponse): TResult {
  if (isPayloadV1(event)) {
    const resp: APIGatewayProxyResult = {
      statusCode: response.status,
      body: response.body ?? "",
      headers: transformHeaders(response.headers ?? {}),
    };
    return resp as TResult;
  } else if (isPayloadV2(event)) {
    const resp: APIGatewayProxyStructuredResultV2 = {
      statusCode: response.status,
      body: response.body ?? undefined,
      headers: transformHeaders(response.headers ?? {}),
    };
    return resp as TResult;
  } else {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: UNKNOWN_PAYLOAD_FORMAT_VERSION_ERROR_MESSAGE,
    });
  }
}

/** Will check the createContext of the TRouter and get the parameter of event.
 * @internal
 **/
type inferAPIGWEvent<
  TRouter extends AnyRouter,
  TEvent extends APIGatewayEvent
> = AWSLambdaOptions<TRouter, TEvent>["createContext"] extends NonNullable<
  AWSLambdaOptions<TRouter, TEvent>["createContext"]
>
  ? Parameters<AWSLambdaOptions<TRouter, TEvent>["createContext"]>[0]["event"]
  : APIGatewayEvent;

/** 1:1 mapping of v1 or v2 input events, deduces which is which.
 * @internal
 **/
type inferAPIGWReturn<T> = T extends APIGatewayProxyEvent
  ? APIGatewayProxyResult
  : T extends APIGatewayProxyEventV2
  ? APIGatewayProxyStructuredResultV2
  : never;
export function lambdaRequestHandler<
  TRouter extends AnyRouter,
  TEvent extends Object,
  TResult extends inferAPIGWReturn<TEvent>
>(
  opts: AWSLambdaOptions<TRouter, TEvent>
): (event: TEvent, context: APIGWContext) => Promise<TResult> {
  return async (event, context) => {
    const req = lambdaEventToHTTPRequest(event);

    const path = getPath(event);

    const createContext = async function _createContext(): Promise<
      inferRouterContext<TRouter>
    > {
      return await opts.createContext?.({ event, context });
    };

    const response = await resolveHTTPResponse({
      router: opts.router,
      batching: opts.batching,
      responseMeta: opts?.responseMeta,
      createContext,
      req,
      path,
      error: null,
      onError(o) {
        opts?.onError?.({
          ...o,
          req: event,
        });
      },
    });

    return tRPCOutputToAPIGatewayOutput<TEvent, TResult>(event, response);
  };
}
