import { createKohoCorpusHandlers } from "@/lib/koho-corpus";
import { kohoCorpusRepo } from "@/repositories";

export const runtime = "nodejs";

const handlers = createKohoCorpusHandlers({ repository: kohoCorpusRepo });

export const GET = handlers.GET;
export const POST = handlers.POST;
