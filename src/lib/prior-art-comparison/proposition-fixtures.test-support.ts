import type { z } from "zod";
import type { batchInput, BatchAnswer } from "./generation-batch";
import type { propositionSourceTransport, propositionTargetTransport, SourceExtraction, targetPropositionSchema } from "./proposition-extraction";
import { fixturePropositionSource, fixturePropositionGeneration, fixturePropositionTarget } from "../../../scripts/prior-art-proposition-fixture.mjs";

/** Typed test adapters around independently reconstructed fictional responses. */
export const fictionalPropositionSource = (input: ReturnType<typeof propositionSourceTransport>): SourceExtraction => fixturePropositionSource(input);
export const fictionalPropositionGeneration = (input: ReturnType<typeof batchInput>): BatchAnswer => fixturePropositionGeneration(input);
export const fictionalPropositionTarget = (input: ReturnType<typeof propositionTargetTransport>): z.infer<typeof targetPropositionSchema> => fixturePropositionTarget(input);
