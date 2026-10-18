import { readFileSync, writeFileSync } from "fs";

const MANIFEST = "dist/manifest.json";
const targetVersion = process.env.npm_package_version;

// read minAppVersion from the manifest and bump version to target version
let manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync(MANIFEST, JSON.stringify(manifest, null, "\t"));

// update versions.json with target version and minAppVersion from the manifest
let versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));
