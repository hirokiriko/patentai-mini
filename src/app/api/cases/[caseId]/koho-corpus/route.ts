import { withOwnerRoute } from "@/lib/owner-http";
import { createKohoCorpusHandlers } from "@/lib/koho-corpus";
import { kohoCorpusRepo } from "@/repositories";

export const runtime = "nodejs";

const handlers = createKohoCorpusHandlers({ repository: kohoCorpusRepo });

 const handleGET = handlers.GET;
 const handlePOST = handlers.POST;

export const GET = withOwnerRoute(handleGET);
export const POST = withOwnerRoute(handlePOST);
