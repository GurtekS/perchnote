#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "@tanstack/react-router";
export const LOCKFILE_PACKAGE_PATH = `node_modules/${PACKAGE_NAME}`;
export const COMPROMISED_RANGE = "1.167.68 through 1.167.71";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function parseExactVersion(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function isCompromisedVersion(value) {
  const version = parseExactVersion(value);
  return (
    version !== null &&
    version.major === 1 &&
    version.minor === 167 &&
    version.patch >= 68 &&
    version.patch <= 71
  );
}

function dependencySpec(manifest, packageName) {
  return (
    manifest.dependencies?.[packageName] ??
    manifest.devDependencies?.[packageName] ??
    manifest.optionalDependencies?.[packageName] ??
    null
  );
}

function validateExactPinnedSpec(errors, source, value) {
  if (value === null) {
    errors.push(`${source} is missing ${PACKAGE_NAME}`);
    return;
  }

  if (!parseExactVersion(value)) {
    errors.push(`${source} must pin ${PACKAGE_NAME} to an exact version, found "${value}"`);
    return;
  }

  if (isCompromisedVersion(value)) {
    errors.push(`${source} uses compromised ${PACKAGE_NAME} version ${value}`);
  }
}

function validateResolvedVersion(errors, source, value) {
  if (typeof value !== "string") {
    errors.push(`${source} is missing a resolved ${PACKAGE_NAME} version`);
    return;
  }

  if (!parseExactVersion(value)) {
    errors.push(`${source} has an invalid resolved ${PACKAGE_NAME} version "${value}"`);
    return;
  }

  if (isCompromisedVersion(value)) {
    errors.push(`${source} resolved compromised ${PACKAGE_NAME} version ${value}`);
  }
}

export function collectErrors(packageJson, packageLock) {
  const errors = [];
  const packageJsonSpec = dependencySpec(packageJson, PACKAGE_NAME);
  const lockRootSpec = dependencySpec(packageLock.packages?.[""] ?? {}, PACKAGE_NAME);
  const lockPackageVersion =
    packageLock.packages?.[LOCKFILE_PACKAGE_PATH]?.version ??
    packageLock.dependencies?.[PACKAGE_NAME]?.version ??
    null;

  validateExactPinnedSpec(errors, "package.json", packageJsonSpec);
  validateExactPinnedSpec(errors, 'package-lock.json packages[""]', lockRootSpec);
  validateResolvedVersion(
    errors,
    `package-lock.json packages["${LOCKFILE_PACKAGE_PATH}"]`,
    lockPackageVersion
  );

  if (
    typeof packageJsonSpec === "string" &&
    typeof lockRootSpec === "string" &&
    packageJsonSpec !== lockRootSpec
  ) {
    errors.push(
      `package-lock.json root spec (${lockRootSpec}) does not match package.json (${packageJsonSpec})`
    );
  }

  if (
    parseExactVersion(packageJsonSpec) &&
    typeof lockPackageVersion === "string" &&
    packageJsonSpec !== lockPackageVersion
  ) {
    errors.push(
      `package-lock.json resolved version (${lockPackageVersion}) does not match package.json (${packageJsonSpec})`
    );
  }

  return errors;
}

export function checkTanstackPin(root = rootDir) {
  const packageJson = readJson(resolve(root, "package.json"));
  const packageLock = readJson(resolve(root, "package-lock.json"));
  return collectErrors(packageJson, packageLock);
}

export function runCli(root = rootDir) {
  const errors = checkTanstackPin(root);

  if (errors.length > 0) {
    console.error(`${PACKAGE_NAME} supply-chain pin check failed.`);
    console.error(`Blocked compromised range: ${COMPROMISED_RANGE}`);
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`${PACKAGE_NAME} pin check passed; blocked range ${COMPROMISED_RANGE}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
