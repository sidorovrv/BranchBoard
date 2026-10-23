import { createPersistedIdSet } from "./persistedIdSet";

const detachedSubagents = createPersistedIdSet("branchboard.detachedSubagents");

export const useDetachedSubagentIds = detachedSubagents.useIds;
export const useSubagentDetached = detachedSubagents.useMember;
