import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import type { OperatorAccess } from "../src/lib/trial/operator-access";
import { trialFixture } from "../src/lib/trial/policy.test-support";

const mocks = vi.hoisted(() => ({ exec: vi.fn(), stat: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = () => { throw Error("CLI fallback forbidden"); };
  Object.defineProperty(execFile, promisify.custom, { value: mocks.exec });
  return { execFile };
});
vi.mock("node:fs/promises", () => ({ lstat: mocks.stat }));

const python = resolve("fictional-parent-cli", process.platform === "win32" ? "python.exe" : "python");
const now = Date.parse("2026-10-10T12:00:00Z");
const storage = "https://storage.azure.com/", arm = "https://management.azure.com/";
let brokerModule: typeof import("./trial-owner-token");

function credential(claimChanges: Record<string, unknown> = {}, responseChanges: Record<string, unknown> = {}) {
  const claims = { oid: trialFixture.auth.ownerId, tid: trialFixture.auth.tenantId,
    aud: storage, exp: now / 1000 + 3600, ...claimChanges };
  return { accessToken: "FICTIONAL-PRIVATE." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".unsigned",
    tenant: trialFixture.auth.tenantId, expires_on: now / 1000 + 3600, ...responseChanges };
}
function access() {
  return { check: vi.fn(), signal: new AbortController().signal } as unknown as OperatorAccess;
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.resetAllMocks(); vi.resetModules();
  mocks.exec.mockRejectedValue(Error("CLI fallback forbidden"));
  mocks.stat.mockRejectedValue(Error("local credential path access forbidden"));
  brokerModule = await import("./trial-owner-token");
});
afterEach(() => {
  expect(mocks.exec).not.toHaveBeenCalled(); expect(mocks.stat).not.toHaveBeenCalled();
  vi.useRealTimers();
});

describe("staged OWNER parent token broker", () => {
  it("uses only the bound parent callback and caches the validated response", async () => {
    const value = credential(), read = vi.fn().mockResolvedValue(value), permit = access();
    brokerModule.installTrialSessionOwnerTokenReader(trialFixture, read);
    const owner = brokerModule.trialOwnerCredential(trialFixture, permit, python);
    const first = await owner.getToken(); expect(first).toEqual({ token: value.accessToken, expiresOnTimestamp: now + 3600_000 });
    expect(await owner.getToken()).toBe(first); expect(read).toHaveBeenCalledExactlyOnceWith(storage);
    expect(permit.check).toHaveBeenCalledWith(30_000);
  });
  it("routes later operator instances through the same installed reader", async () => {
    const read = vi.fn().mockResolvedValue(credential());
    brokerModule.installTrialSessionOwnerTokenReader(trialFixture, read);
    await brokerModule.trialOwnerCredential(trialFixture, access(), python).getToken();
    await brokerModule.trialOwnerCredential(trialFixture, access(), python).getToken();
    // Python owns the cross-operator cache and its one durable debit on miss.
    expect(read).toHaveBeenCalledTimes(2); expect(read.mock.calls).toEqual([[storage], [storage]]);
  });
  it("revokes cached credentials permanently and cannot install a fallback reader", async () => {
    const read = vi.fn().mockResolvedValue(credential());
    const revoke = brokerModule.installTrialSessionOwnerTokenReader(trialFixture, read);
    const owner = brokerModule.trialOwnerCredential(trialFixture, access(), python);
    await owner.getToken(); revoke();
    await expect(owner.getToken()).rejects.toThrow("trial_owner_credential_unavailable");
    await expect(brokerModule.trialOwnerCredential(trialFixture, access(), python).getToken()).rejects.toThrow("trial_owner_credential_unavailable");
    expect(() => brokerModule.installTrialSessionOwnerTokenReader(trialFixture, read)).toThrow("trial_owner_token_reader_already_installed");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("rejects a late token when the session is revoked while its request is pending", async () => {
    let finish!: (value: ReturnType<typeof credential>) => void;
    const pending = new Promise<ReturnType<typeof credential>>(resolve => { finish = resolve; });
    const read = vi.fn().mockReturnValue(pending), revoke = brokerModule.installTrialSessionOwnerTokenReader(trialFixture, read);
    const owner = brokerModule.trialOwnerCredential(trialFixture, access(), python), result = owner.getToken();
    expect(read).toHaveBeenCalledTimes(1); revoke(); finish(credential());
    await expect(result).rejects.toThrow("trial_owner_credential_unavailable");
    await expect(owner.getToken()).rejects.toThrow("trial_owner_credential_unavailable"); expect(read).toHaveBeenCalledTimes(1);
  });
  it.each(["head", "owner", "tenant"] as const)("rejects a different %s before any parent request", async field => {
    const read = vi.fn().mockResolvedValue(credential()); brokerModule.installTrialSessionOwnerTokenReader(trialFixture, read);
    const changed = structuredClone(trialFixture);
    if (field === "head") changed.codeSha = "f".repeat(40);
    else if (field === "owner") changed.auth.ownerId = trialFixture.auth.clientId;
    else changed.auth.tenantId = trialFixture.auth.clientId;
    await expect(brokerModule.trialOwnerCredential(changed, access(), python).getToken()).rejects.toThrow("trial_owner_credential_unavailable");
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects an unknown audience locally without asking the parent", () => {
    const read = vi.fn(); brokerModule.installTrialSessionOwnerTokenReader(trialFixture, read);
    expect(() => brokerModule.trialOwnerCredential(trialFixture, access(), python, "https://graph.microsoft.com/" as typeof storage)).toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    { oid: trialFixture.auth.clientId }, { tid: trialFixture.auth.clientId }, { aud: "https://graph.microsoft.com/" },
    { exp: now / 1000 + 60 }, { nbf: now / 1000 + 1 },
  ])("validates returned OWNER, audience, and time claims without CLI fallback", async changes => {
    const read = vi.fn().mockResolvedValue(credential(changes)); brokerModule.installTrialSessionOwnerTokenReader(trialFixture, read);
    await expect(brokerModule.trialOwnerCredential(trialFixture, access(), python).getToken()).rejects.toThrow("trial_owner_credential_unavailable");
    expect(read).toHaveBeenCalledExactlyOnceWith(storage);
  });
  it.each([
    { tenant: trialFixture.auth.clientId }, { expires_on: now / 1000 + 60 }, { expires_on: NaN },
    { accessToken: "FICTIONAL-PRIVATE.invalid-json.unsigned" },
  ])("rejects malformed broker credentials", async changes => {
    brokerModule.installTrialSessionOwnerTokenReader(trialFixture, vi.fn().mockResolvedValue(credential({}, changes)));
    await expect(brokerModule.trialOwnerCredential(trialFixture, access(), python).getToken()).rejects.toThrow("trial_owner_credential_unavailable");
  });
  it("sanitizes EOF or rejected broker output and never retries automatically", async () => {
    const read = vi.fn().mockRejectedValue(Error("FICTIONAL-PRIVATE token while parent EOF"));
    brokerModule.installTrialSessionOwnerTokenReader(trialFixture, read);
    await expect(brokerModule.trialOwnerCredential(trialFixture, access(), python).getToken()).rejects.toThrow(/^trial_owner_credential_unavailable$/);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("keeps access checks active even for a cached parent response", async () => {
    const read = vi.fn().mockResolvedValue(credential()), permit = access();
    brokerModule.installTrialSessionOwnerTokenReader(trialFixture, read);
    const owner = brokerModule.trialOwnerCredential(trialFixture, permit, python); await owner.getToken();
    vi.mocked(permit.check).mockImplementation(() => { throw Error("session stopped"); });
    await expect(owner.getToken()).rejects.toThrow("trial_owner_credential_unavailable"); expect(read).toHaveBeenCalledTimes(1);
  });
  it("accepts only the canonical ARM alias for an ARM request", async () => {
    const read = vi.fn().mockResolvedValue(credential({ aud: "https://management.core.windows.net/" }));
    brokerModule.installTrialSessionOwnerTokenReader(trialFixture, read);
    await expect(brokerModule.trialOwnerCredential(trialFixture, access(), python, arm).getToken()).resolves.toHaveProperty("token");
    expect(read).toHaveBeenCalledExactlyOnceWith(arm);
    await expect(brokerModule.trialOwnerCredential(trialFixture, access(), python).getToken()).rejects.toThrow("trial_owner_credential_unavailable");
  });
});
