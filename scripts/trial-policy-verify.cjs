"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Fixed CommonJS loader for the existing policy verifier. */
// Fixed repository source only. The public signed policy arrives through stdin.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
let parts = [], size = 0;
process.stdin.on("data", part => {
  size += part.length;
  if (size > 131072) { parts = []; process.stdin.destroy(); process.exitCode = 1; }
  else parts.push(part);
});
process.stdin.on("end", () => {
  try {
    const environment = JSON.parse(Buffer.concat(parts).toString("utf8")); parts = [];
    if (!environment || Object.keys(environment).sort().join(",") !==
      "DEPLOYMENT_KIND,TRIAL_POLICY_JSON,TRIAL_POLICY_PUBLIC_KEY,TRIAL_POLICY_SIGNATURE") throw Error();
    const filename = path.resolve(__dirname, "../src/lib/trial/policy.ts");
    const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(source, filename);
    process.stdout.write(JSON.stringify(loaded.exports.readTrialPolicy(environment)) + "\n");
  } catch { process.stderr.write("trial_policy_unverified\n"); process.exitCode = 1; }
});
process.stdin.on("error", () => { parts = []; process.exitCode = 1; });
