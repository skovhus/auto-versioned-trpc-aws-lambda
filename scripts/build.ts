import { execSync } from "child_process";
import fs from "fs";
import path from "path";

import packageJson from "../package.json";
import { getConfig } from "./config";

const ROOT_PATH = path.join(__dirname, "../");

/**
 * Builds and zips the application.
 */
export async function build(): Promise<{ zipFilePath: string }> {
  const distPath = path.join(ROOT_PATH, "dist");
  const zipFilePath = path.join(distPath, "handler.zip");

  execSync("rm -rf dist && mkdir dist", { cwd: ROOT_PATH });

  const { EXTERNAL_DEPENDENCIES } = getConfig();

  if (EXTERNAL_DEPENDENCIES.length > 0) {
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
  }

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
