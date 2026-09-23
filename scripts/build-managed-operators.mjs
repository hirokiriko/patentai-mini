/** Build the reviewed, clean checkout once; no credentials or network required. */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
function git(...args) {
  return execFileSync("git", ["-c", `safe.directory=${root.replace(/[\\/]$/, "")}`, ...args],
    { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
try {
  if (process.argv.length !== 2 || git("status", "--porcelain", "--untracked-files=all")) throw Error();
  const sha = git("rev-parse", "HEAD");
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error();
  for (const project of ["koho-cloud-import", "managed-watch-cloud"]) {
    execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", `scripts/${project}.tsconfig.json`],
      { cwd: root, windowsHide: true, stdio: "inherit" });
  }
  if (git("status", "--porcelain", "--untracked-files=all") || git("rev-parse", "HEAD") !== sha) throw Error();
  writeFileSync(new URL("../.managed-build-sha", import.meta.url), sha, { mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: "built", codeSha: sha }) + "\n");
} catch {
  process.stderr.write("Operator build requires a clean reviewed checkout and installed dependencies.\n");
  process.exitCode = 2;
}
