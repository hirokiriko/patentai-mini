import type { DraftKind, DraftPatent } from "../repositories/types";

/** Latest at the caller's read time; never substitutes another kind or older prepared data. */
export function latestDraft(drafts: readonly DraftPatent[], kind: DraftKind): DraftPatent | undefined {
  return drafts.reduce<DraftPatent | undefined>((selected, draft) =>
    draft.kind === kind && (!selected || draft.draftId > selected.draftId) ? draft : selected, undefined);
}
