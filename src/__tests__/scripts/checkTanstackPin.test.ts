import { describe, expect, it } from "vitest";
import {
  collectErrors,
  COMPROMISED_RANGE,
  PACKAGE_NAME,
} from "../../../scripts/check-tanstack-pin.mjs";

const safeVersion = "1.167.4";
const packagePath = `node_modules/${PACKAGE_NAME}`;

function packageJson(version: string) {
  return {
    dependencies: {
      [PACKAGE_NAME]: version,
    },
  };
}

function packageLock(rootVersion: string, resolvedVersion = rootVersion) {
  return {
    packages: {
      "": {
        dependencies: {
          [PACKAGE_NAME]: rootVersion,
        },
      },
      [packagePath]: {
        version: resolvedVersion,
      },
    },
  };
}

describe("check-tanstack-pin", () => {
  it("accepts the current safe exact pin in package.json and package-lock.json", () => {
    expect(collectErrors(packageJson(safeVersion), packageLock(safeVersion))).toEqual([]);
  });

  it.each(["1.167.68", "1.167.69", "1.167.70", "1.167.71"])(
    `rejects compromised ${PACKAGE_NAME} %s from ${COMPROMISED_RANGE}`,
    (version) => {
      expect(collectErrors(packageJson(version), packageLock(version))).toEqual([
        `package.json uses compromised ${PACKAGE_NAME} version ${version}`,
        `package-lock.json packages[""] uses compromised ${PACKAGE_NAME} version ${version}`,
        `package-lock.json packages["${packagePath}"] resolved compromised ${PACKAGE_NAME} version ${version}`,
      ]);
    },
  );

  it("rejects lockfile drift into the compromised range even when package.json is safe", () => {
    expect(collectErrors(packageJson(safeVersion), packageLock(safeVersion, "1.167.69"))).toEqual([
      `package-lock.json packages["${packagePath}"] resolved compromised ${PACKAGE_NAME} version 1.167.69`,
      `package-lock.json resolved version (1.167.69) does not match package.json (${safeVersion})`,
    ]);
  });

  it("rejects non-exact specs that could float into the compromised range", () => {
    expect(collectErrors(packageJson("^1.167.4"), packageLock("^1.167.4", safeVersion))).toEqual([
      `package.json must pin ${PACKAGE_NAME} to an exact version, found "^1.167.4"`,
      `package-lock.json packages[""] must pin ${PACKAGE_NAME} to an exact version, found "^1.167.4"`,
    ]);
  });
});
