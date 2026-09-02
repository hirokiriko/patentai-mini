import { createPatentWatchHandlers } from "@/lib/patent-watch/api";
import { patentWatchRepo } from "@/repositories";

export const runtime = "nodejs";

const handlers = createPatentWatchHandlers({ repository: patentWatchRepo });

export const GET = handlers.GET;
export const PUT = handlers.PUT;
