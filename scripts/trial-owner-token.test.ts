import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { OperatorAccess } from "../src/lib/trial/operator-access";
import { trialFixture } from "../src/lib/trial/policy.test-support";

const mocks = vi.hoisted(() => ({ exec: vi.fn(), stat: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = () => { throw Error("callback route forbidden in fixture"); };
  Object.defineProperty(execFile, promisify.custom, { value: mocks.exec });
  return { execFile };
});
vi.mock("node:fs/promises", () => ({ lstat: mocks.stat }));
import { trialAzureCliPythonSchema, trialOwnerCredential } from "./trial-owner-token";

const python = resolve("fictional-approved-cli", process.platform === "win32" ? "python.exe" : "python");
const now = Date.parse("2026-10-10T12:00:00Z");
function response(change: Record<string, unknown> = {}) {
  const claims = { oid: trialFixture.auth.ownerId, tid: trialFixture.auth.tenantId,
    aud: "https://storage.azure.com/", exp: now / 1000 + 3600, ...change };
  return { stdout: JSON.stringify({ accessToken: "fixture." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".fixture",
    tenant: trialFixture.auth.tenantId, expires_on: now / 1000 + 3600 }), stderr: "" };
}
function access() {
  return { check: vi.fn(), signal: new AbortController().signal } as unknown as OperatorAccess;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.resetAllMocks();
  mocks.stat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false });
  mocks.exec.mockResolvedValue(response());
});
afterEach(() => vi.useRealTimers());

describe("fixed normal OWNER CLI Python", () => {
  it("uses the exact private absolute Python with isolation, no shell and bounded token capture", async () => {
    const permit = access(), credential = trialOwnerCredential(trialFixture, permit, python);
    const token = await credential.getToken();
    expect(token.expiresOnTimestamp).toBe(now + 3600_000);
    expect(mocks.exec).toHaveBeenCalledWith(python,
      ["-I", "-m", "azure.cli", "account", "get-access-token", "--resource", "https://storage.azure.com/", "--output", "json", "--only-show-errors"],
      { windowsHide: true, shell: false, timeout: 30000, maxBuffer: 65536, signal: permit.signal });
    await credential.getToken(); expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(permit.check).toHaveBeenCalledWith(30000);
  });
  it.each(["python", "az.cmd", "./python", resolve("fictional-approved-cli", "az.bat")])("rejects a nonfixed Python route %s", path => {
    expect(trialAzureCliPythonSchema.safeParse(path).success).toBe(false);
    expect(() => trialOwnerCredential(trialFixture, access(), path)).toThrow();
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("rejects symlinks before executing", async () => {
    mocks.stat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => true });
    await expect(trialOwnerCredential(trialFixture, access(), python).getToken()).rejects.toThrow("trial_owner_credential_unavailable");
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it.each([
    { oid: trialFixture.auth.clientId }, { tid: trialFixture.auth.clientId },
    { aud: "https://graph.microsoft.com/" }, { exp: now / 1000 + 59 }, { nbf: now / 1000 + 1 },
  ])("rejects wrong OWNER/tenant/audience/expiry claims", async change => {
    mocks.exec.mockResolvedValue(response(change));
    await expect(trialOwnerCredential(trialFixture, access(), python).getToken()).rejects.toThrow("trial_owner_credential_unavailable");
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  });
  it("supports only the existing canonical ARM audience alias for ARM", async () => {
    mocks.exec.mockResolvedValue(response({ aud: "https://management.core.windows.net/" }));
    await expect(trialOwnerCredential(trialFixture, access(), python, "https://management.azure.com/").getToken()).resolves.toHaveProperty("token");
    await expect(trialOwnerCredential(trialFixture, access(), python).getToken()).rejects.toThrow();
  });
  it("does not fall back or expose failed command output", async () => {
    mocks.exec.mockRejectedValue(Error("fictional-private-token-output"));
    await expect(trialOwnerCredential(trialFixture, access(), python).getToken()).rejects.toThrow("trial_owner_credential_unavailable");
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  });
  it("checks permit even before returning a cached token", async () => {
    const permit = access(), credential = trialOwnerCredential(trialFixture, permit, python);
    await credential.getToken(); vi.mocked(permit.check).mockImplementation(() => { throw Error("expired"); });
    await expect(credential.getToken()).rejects.toThrow("trial_owner_credential_unavailable");
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  });
});
