import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ContainerClient } from "@azure/storage-blob";
import { OperatorAccess, operatorPolicyBinding, operatorTicketDigest, type OperatorTicket } from "./operator-access";
import { trialHash } from "./ledger";
import { TRIAL_START } from "./policy";
import { trialFixture, signedTrialEnvironment } from "./policy.test-support";
import { trialStorageHttp } from "./storage";
import { OwnerStorageBudget, ownerStorageBudget, OWNER_STORAGE_BODY_LIMIT, OWNER_STORAGE_REQUEST_LIMIT } from "./storage-budget";
import { networkBudgetFixture } from "./network-budget.test-support";

const start = Date.parse(TRIAL_START);
const cleanup: Array<{ directory: string; access: OperatorAccess; budget?: OwnerStorageBudget }> = [];
function setup(limits: { requests?: number; reservedBodyBytes?: number } = {}) {
  vi.useFakeTimers(); vi.setSystemTime(start + 1000);
  const directory = resolve(mkdtempSync(join(tmpdir(), "trial-owner-storage-")));
  const p = structuredClone(trialFixture);
  const ticket: OperatorTicket = { schema: 1, id: "11111111-1111-4111-8111-111111111111", policyDigest: operatorPolicyBinding(p),
    startsAt: new Date(start).toISOString(), endsAt: new Date(start + 3_600_000).toISOString(), packages: [], samples: [], artifacts: [] };
  p.localOperator = { ticketDigest: operatorTicketDigest(ticket), recoveryDirectoryDigest: trialHash(directory) };
  const access = new OperatorAccess(ticket, p, { utc: () => Date.now(), monotonic: () => Date.now() - start });
  const row = { directory, access, budget: ownerStorageBudget(directory, access, limits) };
  cleanup.push(row);
  for (const [key, value] of Object.entries(signedTrialEnvironment(p))) vi.stubEnv(key, value);
  const path = join(directory, "owner-storage-budget.jsonl");
  return { ...row, p, ticket, path };
}
function client(p: typeof trialFixture, access: OperatorAccess, budget: OwnerStorageBudget | undefined, transport: typeof fetch) {
  return new ContainerClient(`https://${p.storage.account}.blob.core.windows.net/${p.storage.budget}`,
    { getToken: async () => ({ token: "fictional", expiresOnTimestamp: start + 7_200_000 }) },
    { retryOptions: { maxTries: 1 }, httpClient: trialStorageHttp("budget", p, transport, access, budget,networkBudgetFixture(p).budget) });
}
afterEach(() => {
  for (const item of cleanup.splice(0)) {
    item.budget?.close(); item.access.dispose();
    const path = join(item.directory, "owner-storage-budget.jsonl");
    if (existsSync(path)) unlinkSync(path);
    rmdirSync(item.directory);
  }
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe("one-session OWNER Storage allowance", () => {
  it("shares the quota across commands and durably consumes it before send", () => {
    const { directory, access, budget, path } = setup({ requests: 2 });
    expect(ownerStorageBudget(directory, access, { requests: 2 })).toBe(budget);
    budget.reserve(access, 12);
    const records = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records[1]).toMatchObject({ sequence: 1, requestBodyBytes: 12, maximumResponseBytes: OWNER_STORAGE_BODY_LIMIT, outcome: "unknown_before_send" });
    budget.reserve(access, 0);
    expect(() => budget.reserve(access, 0)).toThrow("trial_owner_storage_budget_exhausted");
    expect(budget.snapshot().requests).toBe(2);
  });
  it("cannot reopen a session after close or use a fresh ticket to reset it", () => {
    const { directory, access, budget, p, ticket } = setup();
    budget.reserve(access, 0); budget.close();
    expect(() => new OwnerStorageBudget(directory, access)).toThrow("trial_owner_storage_budget_unavailable");
    expect(() => ownerStorageBudget(directory, access).reserve(access, 0)).toThrow("trial_owner_storage_budget_stopped");
    const changed = { ...ticket, id: "22222222-2222-4222-8222-222222222222" };
    p.localOperator!.ticketDigest = operatorTicketDigest(changed);
    const other = new OperatorAccess(changed, p);
    try { expect(() => ownerStorageBudget(directory, other)).toThrow("trial_owner_storage_budget_binding"); }
    finally { other.dispose(); }
  });
  it("fails closed on a changed journal and never refunds the failed reservation", () => {
    const { access, budget, path } = setup();
    appendFileSync(path, "unexpected\n");
    expect(() => budget.reserve(access, 0)).toThrow("trial_owner_storage_budget_unavailable");
    expect(budget.snapshot()).toMatchObject({ requests: 1, stopped: true });
    expect(() => budget.reserve(access, 0)).toThrow("trial_owner_storage_budget_stopped");
  });
  it("bounds each body, total reserved bodies and configurable limits without enlargement", () => {
    const { directory, access, budget } = setup({ reservedBodyBytes: OWNER_STORAGE_BODY_LIMIT });
    expect(() => budget.reserve(access, OWNER_STORAGE_BODY_LIMIT + 1)).toThrow("trial_owner_storage_body_limit");
    budget.reserve(access, 0);
    expect(() => budget.reserve(access, 0)).toThrow("trial_owner_storage_budget_exhausted");
    expect(() => new OwnerStorageBudget(directory, access, { requests: OWNER_STORAGE_REQUEST_LIMIT + 1 })).toThrow("trial_owner_storage_budget_invalid");
    expect(budget.snapshot().reservedBodyBytes).toBe(OWNER_STORAGE_BODY_LIMIT);
  });
  it("persists the charge before the actual fetch, including a failed/unknown send", async () => {
    const { p, access, budget, path } = setup();
    const send = vi.fn(async () => {
      const records = readFileSync(path, "utf8").trim().split("\n");
      expect(JSON.parse(records.at(-1)!)).toMatchObject({ sequence: 1, outcome: "unknown_before_send" });
      throw new Error("fictional transport failure");
    });
    await expect(client(p, access, budget, send).getProperties()).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce(); expect(budget.snapshot().requests).toBe(1);
  });
  it("allows bounded successful requests until the shared transport allowance is exhausted", async () => {
    const { p, access, budget } = setup({ requests: 2 });
    const send = vi.fn(async () => new Response(null, { status: 200, headers: { "content-length": "0" } }));
    const container = client(p, access, budget, send);
    await container.getProperties(); await container.getProperties();
    await expect(container.getProperties()).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(2); expect(budget.snapshot().requests).toBe(2);
  });
  it("rechecks expiry after the durable reservation without sending or refunding it", async () => {
    const { p, access, budget } = setup();
    const reserve = budget.reserve.bind(budget);
    vi.spyOn(budget, "reserve").mockImplementation((operator, bytes) => {
      reserve(operator, bytes); vi.setSystemTime(start + 3_600_000);
    });
    const send = vi.fn();
    await expect(client(p, access, budget, send).getProperties()).rejects.toThrow();
    expect(send).not.toHaveBeenCalled(); expect(budget.snapshot().requests).toBe(1);
  });
  it("denies OWNER sends without a session budget and oversize bodies before transport", async () => {
    const { p, access, budget } = setup(); const send = vi.fn();
    await expect(client(p, access, undefined, send).getProperties()).rejects.toThrow();
    await expect(client(p, access, budget, send).getBlockBlobClient("trial-v1/state.json").uploadData(Buffer.alloc(OWNER_STORAGE_BODY_LIMIT + 1))).rejects.toThrow();
    expect(send).not.toHaveBeenCalled(); expect(budget.snapshot().requests).toBe(0);
  });
  it.each([undefined, String(OWNER_STORAGE_BODY_LIMIT + 1)])("rejects unbounded declared response length %s without refund", async length => {
    const { p, access, budget } = setup();
    const send = vi.fn(async () => new Response(null, { status: 200, headers: length ? { "content-length": length } : {} }));
    await expect(client(p, access, budget, send).getProperties()).rejects.toThrow();
    expect(budget.snapshot().requests).toBe(1);
  });
});
