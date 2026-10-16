import fixed from "./catalog-pg16-builtins.json";
import { builtinManifestSchema } from "./catalog-schema";
/** Captured by the isolated PG16 test with --pull never. No live catalog can
 * replace this source artifact; unknown platform additions fail closed. */
export function loadCatalogBuiltins(){return builtinManifestSchema.parse(fixed);}
