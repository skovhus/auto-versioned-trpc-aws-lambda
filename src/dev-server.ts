/**
 * Very quick and dirty alternative to pulling down serverless-offline.
 * Alternative would be to not use the lambda adapter for local development.
 */
import express, { Express, Request, Response } from "express";
import { rawHandler } from ".";

const app: Express = express();
const port = process.env.PORT || 4000;

app.get("*", async (req: Request, res: Response) => {
  const notImplemented = "notImplemented" as any;

  const response = await rawHandler(
    {
      body: req.body,
      headers: {},
      multiValueHeaders: notImplemented,
      httpMethod: req.method,
      isBase64Encoded: false,
      path: req.path,
      pathParameters: notImplemented,
      queryStringParameters: notImplemented,
      multiValueQueryStringParameters: notImplemented,
      stageVariables: notImplemented,
      requestContext: notImplemented,
      resource: notImplemented,
    },
    notImplemented
  );
  res.set(response.headers);
  res.status(response.statusCode);
  res.send(response.body);
});

app.listen(port, () => {
  console.log(`⚡️[server]: Server is running at http://localhost:${port}`);
});
