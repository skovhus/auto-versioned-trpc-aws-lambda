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

## Proposal: Multiple immutable auto versioned tRPC servers

In this proof of concept, we look into automatic versioning of endpoints. The idea: deploy multiple immutable tRPC servers – each prefixed with a hash of the content of the server.

Here we are using the node.js AWS SDK to deploy the AWS Lambda.

What goes on behind the scenes?

For every deploy:

1. Check if any lambda matches the hash of the server (skip the rest if that is the case)
2. Create a new lambda function + add a Function URL

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
export SERVICE_LAMBDA_ROLE="versioned-trpc-lambda-role"

# create an IAM role for the lambda
aws iam create-role --role-name "$SERVICE_LAMBDA_ROLE" --assume-role-policy-document file://trust-policy-lambda.json
```

## AWS Deployment

Run the deployment of the service.

```
AWS_REGION=eu-west-1 yarn esno scripts/deploy.ts
```

## AWS Clean up

This should clean up most of the mess this proof of concept created in your AWS account...

```sh
# TODO: script to delete functions
aws iam delete-role --role-name versioned-trpc-lambda-role
```
