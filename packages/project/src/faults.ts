export type CommitBarrier =
  | 'afterStagingPayloads'
  | 'afterPrepare'
  | 'afterPayloadPublish'
  | 'afterSnapshotPublish'
  | 'afterCommitPublish'
  | 'afterHeadReplace';

type BarrierHandler = (barrier: CommitBarrier) => void | Promise<void>;

let testHandler: BarrierHandler | undefined;

export const hitCommitBarrier = async (barrier: CommitBarrier): Promise<void> => {
  await testHandler?.(barrier);
};

// Deliberately not exported from the package public entry point.
export const setCommitBarrierForTest = (handler?: BarrierHandler): void => {
  testHandler = handler;
};
