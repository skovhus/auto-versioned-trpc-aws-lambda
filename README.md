# auto-versioned-trpc-aws-lambda

Proof of concept to support an automatically versioned AWS Lambda running [tRPC](https://trpc.io/) to ensure a somewhat graceful and automated handling of client/server compatibility. Note that the solution here is not really specific to tRPC.

## The problem

The concept of removing the boundary between the frontend and backend environment as seen in libraries like [tRPC](https://trpc.io/), [Remix](https://remix.run/), [Next.js](https://vercel.com/solutions/nextjs) is a really pleasant and effective way of building web applications. But the abstraction is also leaky as it usually hides the fact that the frontend and backend environment cannot practically be updated at the same time – a stale web browser will eventually make calls to a newer version of the server.

Here we investigate a solution for [tRPC](https://trpc.io/). The main selling point of tRPC is "End-to-end typesafe APIs made easy", but this doesn't hold if you are not mindful about deployment or keeping your client/server versions in sync – something that isn't trivially solved.

### Options for solving this

We have several options to try to solve the client/server version compatibility:

- **force clients to be in sync** with the latest server. We cannot guarantee this, but we can nudge the user to reload their browser, update when the user navigates, and add a reload CTA in case of API failures for forms/actions.
- **versioning** (manually or automated) the endpoints and gracefully keep old versions around until clients have migrated to the new endpoints. Manual versioning is standard practice but doesn't fit well with tRPC and Remix, where the actual endpoints are abstracted away.
- **backward compatible endpoints for a grace period** until we expect the clients to be updated. This can likely be enforced by a type checker build time by checking old endpoints are still present and the input and output DTOs are a superset of previous versions.

### How does framework X solve this?

Some observations when looking at how this is handled in different frameworks and tools:

- GraphQL: [”avoid breaking changes by making it backward compatible”](https://graphql.org/learn/best-practices/#versioning).
- Next.js: [automatically load the latest version](https://nextjs.org/docs/deployment#automatic-updates) in the background when routing. But API Routes (which are usually used for actions/forms) are not automatically versioned. This means you can easily break actions if you are not manually versioning the API Routes.
- Remix: Any action on the page (e.g. forms) will break if the client is outdated and the loader is not compatible...
- tRPC: the community suggests keeping the client up to date

### Multiple immutable auto versioned tRPC servers

In this proof of concept, we look into automatic versioning of endpoints. The idea: deploy multiple immutable tRPC servers – each prefixed with a hash of the content of the server.

Here we are using the node.js AWS SDK to deploy the AWS Lambda – any declarative framework (e.g. Terrraform or Serverless) doesn't fit well with creating a lot of dynamic resources for each deployment.

What goes on behind the scenes?

For every deploy:
1. Update lambda function code + publish it + create an alias to that specific version
2. AWS API Gateway: create resource matching the auto generated version key → create a `{proxy+}` child resource
3. AWS API gateway: integrate the new version of the lambda function with the proxy resource → release the gateway

⚠️ Note that AWS makes this a multi step process to update their API Gateway with the dynamic resource... And we can end up in a bad state if the deployment fails while create resources – something the deploy script takes care of. 

## Local development

Setup:

```sh
yarn install
```

Local development:

```sh
yarn start
```

## AWS Provisioning

The deployment requires a bit of provisioning.

```sh
export AWS_REGION=eu-west-1
export SERVICE_FUNCTION_NAME="versioned-trpc"
export SERVICE_GATEWAY="versioned-trpc-gateway"
export SERVICE_LAMBDA_ROLE="versioned-trpc-lambda-role"

# create an IAM role for the lambda
aws iam create-role --role-name "$SERVICE_LAMBDA_ROLE" --assume-role-policy-document file://trust-policy-lambda.json

# attach a policy so API Gateway can integrate with the lambda
aws iam attach-role-policy --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaRole --role-name "$SERVICE_LAMBDA_ROLE"

# create an API Gateway
aws apigateway create-rest-api --region $AWS_REGION --name "$SERVICE_GATEWAY"

# create a dummy lambda function
export LAMBDA_ARN_ROLE=$(aws iam get-role --role-name $SERVICE_LAMBDA_ROLE | jq .Role.Arn --raw-output)
echo "console.log('hello')" > dummy.js && zip dummy.zip dummy.js
aws lambda create-function \
      --function-name "$SERVICE_FUNCTION_NAME" \
      --runtime nodejs14.x \
      --zip-file fileb://dummy.zip \
      --handler dist/index.handler \
      --role "$LAMBDA_ARN_ROLE"
```

## AWS Deployment

Run the deployment of the service.

```
AWS_REGION=eu-west-1 yarn esno scripts/deploy.ts
```

## AWS Clean up

This should clean up most of the mess this proof of concept created in your AWS account...

```sh
aws lambda delete-function --function-name versioned-trpc
aws apigateway delete-rest-api --rest-api-id=$(aws apigateway get-rest-apis --query 'items[?name==`versioned-trpc-gateway`]' | jq '.[0].id' --raw-output)
aws iam detach-role-policy --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaRole --role-name versioned-trpc-lambda-role
aws iam delete-role --role-name versioned-trpc-lambda-role
```
