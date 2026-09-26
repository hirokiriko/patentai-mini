import { z } from "zod";
import { KOHO_UPLOAD_CHUNK_BYTES, kohoUploadCreateSchema, publicKohoUpload } from "./upload-contract";
import { configuredKohoUpload } from "./upload-config";
import { startKohoUpload, uploadManagedArm } from "./upload-arm";

class UploadInputError extends Error {}
/** Bound the stream itself; Content-Length alone is not an upload limit. */
export async function readUploadBody(request: Request, maximum: number, signal: AbortSignal) {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d{1,10}$/.test(length) || Number(length) > maximum)) throw new UploadInputError();
  const reader = request.body?.getReader();
  if (!reader) throw new UploadInputError();
  const chunks: Buffer[] = []; let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const part = await reader.read(); signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum) throw new UploadInputError();
      chunks.push(Buffer.from(part.value));
    }
    if (!bytes || (length !== null && bytes !== Number(length))) throw new UploadInputError();
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", abort); await reader.cancel().catch(() => undefined); reader.releaseLock();
  }
}
async function jsonBody(request: Request, signal: AbortSignal) {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") throw new UploadInputError();
  try { return JSON.parse((await readUploadBody(request, 2048, signal)).toString("utf8")) as unknown; }
  catch { throw new UploadInputError(); }
}
/** Fixed actions only. No storage path, credentials, job template, or prices from HTTP. */
export function kohoUploadHandlers(configure = configuredKohoUpload, arm = uploadManagedArm) {
  async function safe(request: Request, fn: (signal: AbortSignal) => Promise<unknown>) {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(110_000)]);
    try { return Response.json(await fn(signal)); }
    catch (e) { return Response.json({ error: e instanceof UploadInputError || e instanceof z.ZodError ? "upload_input_invalid" : "upload_unavailable" },
      { status: e instanceof UploadInputError || e instanceof z.ZodError ? 400 : 503 }); }
  }
  return {
    metadata: (r: Request) => safe(r, async signal => {
      const store = await configure(signal);
      return { maxBytes: store.settings.maxBytes, chunkBytes: KOHO_UPLOAD_CHUNK_BYTES, serverTime: new Date().toISOString() };
    }),
    create: (r: Request) => safe(r, async signal => {
      const input = kohoUploadCreateSchema.parse(await jsonBody(r, signal)), store = await configure(signal);
      return publicKohoUpload(await store.create(input));
    }),
    status: (r: Request, id: string) => safe(r, async signal => {
      z.uuidv4().parse(id); return publicKohoUpload(await (await configure(signal)).reconciled(id));
    }),
    chunk: (r: Request, id: string, index: string) => safe(r, async signal => {
      z.uuidv4().parse(id);
      if (!/^(0|[1-9][0-9]{0,3})$/.test(index) || Number(index) >= 2048 || r.headers.get("content-type") !== "application/octet-stream") throw new UploadInputError();
      const bytes = await readUploadBody(r, KOHO_UPLOAD_CHUNK_BYTES, signal), store = await configure(signal);
      return publicKohoUpload(await store.chunk(id, Number(index), bytes));
    }),
    action: (r: Request, id: string) => safe(r, async signal => {
      z.uuidv4().parse(id);
      const input = z.object({ action: z.enum(["reconcile", "seal", "start"]) }).strict().parse(await jsonBody(r, signal));
      const store = await configure(signal);
      const state = input.action === "reconcile" ? await store.reconcileChunk(id) : input.action === "seal" ? await store.seal(id) :
        await startKohoUpload(store, id, arm(store.settings.job.resourceId, signal));
      return publicKohoUpload(state);
    }),
  };
}
