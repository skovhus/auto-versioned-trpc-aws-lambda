#!/usr/bin/env bash

# TODO: skip deployments if nothing changed (is hash needed then?)

set -euxo pipefail

if [[ -z "${AWS_REGION}" ]]; then
  echo "Please specify environment variable: AWS_REGION"
  exit 1
fi

export AWS_PAGER="" # disable AWS CLI pager

SERVICE_FUNCTION_NAME="versioned-trpc"
SERVICE_GATEWAY="versioned-trpc-gateway"
LAMBDA_ARN_ROLE=$(aws iam get-role --role-name versioned-trpc-lambda-role | jq .Role.Arn --raw-output)

ALIAS_FUNCTION_NAME="" # this is set by build_and_deploy_lambda


# TODO: there must be a better way... Polling?
function wait_a_bit_for_eventual_consistency() {
  sleep 1
}

# Build and deploy an aliased lambda function
function build_and_deploy_lambda() {
  # build and zip
  yarn esbuild --bundle src/index.ts --outdir=dist --minify --platform=node
  zip dist/handler.zip dist/index.js

  if aws lambda get-function --function-name $SERVICE_FUNCTION_NAME; then
    aws lambda update-function-code \
    --function-name "$SERVICE_FUNCTION_NAME" \
    --zip-file fileb://dist/handler.zip
  else
    # TODO: this should be done when provisioning
    aws lambda create-function \
      --function-name "$SERVICE_FUNCTION_NAME" \
      --runtime nodejs14.x \
      --zip-file fileb://dist/handler.zip \
      --handler dist/index.handler \
      --role "$LAMBDA_ARN_ROLE"
  fi

  wait_a_bit_for_eventual_consistency

  FUNCTION_VERSION=$(aws lambda publish-version --function-name $SERVICE_FUNCTION_NAME | jq .Version --raw-output)
  ALIAS_FUNCTION_NAME="v$FUNCTION_VERSION"
  FUNCTION_ALIAS_ARN=$(aws lambda list-aliases --function-name $SERVICE_FUNCTION_NAME --query "Aliases[?FunctionVersion=='$FUNCTION_VERSION']" | jq '.[0].AliasArn' --raw-output)

  if [ -n "$FUNCTION_ALIAS_ARN" ];
  then
    FUNCTION_ALIAS_ARN=$(aws lambda create-alias \
      --function-name "$SERVICE_FUNCTION_NAME" \
      --name "$ALIAS_FUNCTION_NAME" \
      --function-version "$FUNCTION_VERSION" | jq .AliasArn --raw-output)
  fi
}

# Update the API Gateway resources and integrations to include the new function
function update_api_gateway() {
  API_REST_ID=$(aws apigateway get-rest-apis --query "items[?name=='$SERVICE_GATEWAY']" | jq '.[0].id' --raw-output)
  API_ROOT_ID=$(aws apigateway get-resources --rest-api-id "$API_REST_ID" --query "items[?path=='/']" | jq '.[0].id' --raw-output)

  # create a resource with the same path as ALIAS_FUNCTION_NAME
  API_LATEST_RESOURCE_ID=$(aws apigateway create-resource --rest-api-id "$API_REST_ID" \
        --parent-id "$API_ROOT_ID" \
        --path-part "$ALIAS_FUNCTION_NAME" | jq .id --raw-output)

  # add a proxy resource path
  API_LATEST_PROXY=$(aws apigateway create-resource --rest-api-id "$API_REST_ID" \
        --parent-id "$API_LATEST_RESOURCE_ID" \
        --path-part '{proxy+}' | jq .id --raw-output)

  # add a method to the proxy resource path accepting any HTTP method
  aws apigateway put-method --rest-api-id "$API_REST_ID" \
        --resource-id "$API_LATEST_PROXY" \
        --http-method ANY \
        --authorization-type "NONE"

  # integrate the lambda function
  aws apigateway put-integration \
        --rest-api-id "$API_REST_ID" \
        --resource-id "$API_LATEST_PROXY" \
        --http-method ANY \
        --integration-http-method POST \
        --type AWS_PROXY \
        --region "$AWS_REGION" \
        --credentials "$LAMBDA_ARN_ROLE" \
        --uri "arn:aws:apigateway:$AWS_REGION:lambda:path/2015-03-31/functions/$FUNCTION_ALIAS_ARN/invocations"

  wait_a_bit_for_eventual_consistency

  # finally deploy the gateway
  aws apigateway create-deployment --rest-api-id "$API_REST_ID" --stage-name staging

  echo "API is live in a few seconds at https://$API_REST_ID.execute-api.$AWS_REGION.amazonaws.com/staging/$ALIAS_FUNCTION_NAME/greet"
}

build_and_deploy_lambda

update_api_gateway
