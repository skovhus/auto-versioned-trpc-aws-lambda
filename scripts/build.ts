import { execSync } from "child_process";
import fs from "fs";
import path from "path";

import packageJson from "../package.json";

const ROOT_PATH = path.join(__dirname, "../");

// Dependencies to exclude from the bundle and minification
const EXTERNAL_DEPENDENCIES: string[] = [];

/**
 * Builds and zips the application.
 * TODO: should be done before running this script.
 */
export async function build(): Promise<{ zipFilePath: string }> {
  const distPath = path.join(ROOT_PATH, "dist");
  const zipFilePath = path.join(distPath, "handler.zip");

  execSync("rm -rf dist && mkdir dist", { cwd: ROOT_PATH });

  const tmpPackageJson = {
    dependencies: Object.entries(packageJson.dependencies)
      .filter(([dependencyName]) =>
        EXTERNAL_DEPENDENCIES.includes(dependencyName)
      )
      .reduce(
        (prev, [dependencyName, version]) => ({
          ...prev,
          [dependencyName]: version,
        }),
        {}
      ),
  };

  fs.writeFileSync(
    path.join(distPath, "package.json"),
    JSON.stringify(tmpPackageJson)
  );

  execSync("yarn install --no-lockfile", { cwd: distPath });

  const externals = EXTERNAL_DEPENDENCIES.map((d) => `--external:${d}`).join(
    " "
  );
  execSync(
    `yarn esbuild --bundle src/index.ts --outdir=dist --minify --platform=node ${externals}`,
    { cwd: ROOT_PATH }
  );

  execSync(`zip -r ${zipFilePath} dist`, { cwd: ROOT_PATH });

  return { zipFilePath };
}
