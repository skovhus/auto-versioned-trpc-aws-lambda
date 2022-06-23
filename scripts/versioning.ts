import { execSync } from "child_process";
import fs from "fs";
import os from "os";

import hashObject from "object-hash";

import { getConfig } from "./config";

/**
 * Compute a hash for all files found in the given path.
 * NOTE: the path should not contain zip files as hashing them is not deterministic.
 */
function computeHashFromPath(path: string) {
  return execSync(
    `find ${path} -type f -print0 | sort -z | xargs -0 shasum | awk '{ print $1 }' | shasum | awk '{ print $1 }'`
  )
    .toString()
    .trim();
}

/**
 * Compute the has of the zip file content.
 * TODO: this should also take into account environment variable or other
 * factors that should trigger a redeploy.
 */
function getHashOfZipFileContent(zipFilePath: string) {
  const tmpPath = fs.mkdtempSync(os.tmpdir());

  execSync(`unzip ${zipFilePath} -d ${tmpPath}`);

  // We cannot assume that we the node_modules produces a stable hash (e.g. native code or zip files),
  // but we rely on the package.json file as a fingerprint for dependencies.
  execSync(`rm -rf "${tmpPath}/dist/node_modules"`); // but is covered by the package.json file

  return computeHashFromPath(tmpPath);
}

/**
 * Compute an automatic stable version the given lambda to skip deployment if the
 * source code, deploy script and environment variables have not changed.
 */
export function computeVersion({
  lambdaZipFilePath,
}: {
  lambdaZipFilePath: string;
}) {
  const tStart = new Date().getTime();

  const entries = {
    zipFileContent: getHashOfZipFileContent(lambdaZipFilePath),
    deployScriptContent: computeHashFromPath(__dirname),
    config: getConfig(),
  };

  const version = hashObject(entries).substring(0, 14);

  console.info(
    `Computed version in ${new Date().getTime() - tStart}ms: ${version}`
  );

  return version;
}
