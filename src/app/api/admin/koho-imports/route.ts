import { withOwnerRoute } from "@/lib/owner-http";
import { createKohoManualImportPostHandler } from "@/lib/koho-import/manual-api";
import { KohoImportPlanValidationError } from "@/lib/koho-import";
import {
  kohoImportRepo,
  KohoImportRepositoryValidationError,
} from "@/repositories";

export const runtime = "nodejs";

 const handlePOST = createKohoManualImportPostHandler({
  repository: kohoImportRepo,
  isValidationError: (error) =>
    error instanceof KohoImportPlanValidationError ||
    error instanceof KohoImportRepositoryValidationError,
});

export const POST = withOwnerRoute(handlePOST);
