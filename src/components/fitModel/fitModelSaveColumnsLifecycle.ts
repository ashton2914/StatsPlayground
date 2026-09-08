export type FitModelSaveColumnsOutcome =
  | { status: "saveFailed"; error: unknown }
  | { status: "committed"; postCommitError: unknown | null };

export async function runFitModelSaveColumnsLifecycle<T>({
  save,
  onCommitted,
  afterCommit,
}: {
  save: () => Promise<T>;
  onCommitted: (result: T) => void;
  afterCommit: (result: T) => Promise<void>;
}): Promise<FitModelSaveColumnsOutcome> {
  let result: T;
  try {
    result = await save();
  } catch (error) {
    return { status: "saveFailed", error };
  }

  onCommitted(result);
  try {
    await afterCommit(result);
    return { status: "committed", postCommitError: null };
  } catch (postCommitError) {
    return { status: "committed", postCommitError };
  }
}