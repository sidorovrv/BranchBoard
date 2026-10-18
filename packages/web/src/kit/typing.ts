import { EditorState, type TransactionSpec } from "@codemirror/state";
import { autoFormatTyped, normalizePastedLists } from "@branchboard/core";

export const autoFormatTypedText = EditorState.transactionFilter.of((transaction): TransactionSpec | readonly TransactionSpec[] => {
  if (!transaction.docChanged || !transaction.isUserEvent("input")) return transaction;
  const next = transaction.newDoc.toString();
  const formatted = autoFormatTyped(transaction.startState.doc.toString(), next, transaction.newSelection.main.head);
  if (!formatted) return transaction;
  return [transaction, { changes: { from: 0, to: next.length, insert: formatted.text }, selection: { anchor: formatted.caret }, sequential: true }];
});

export const normalizedPaste = (event: ClipboardEvent): string | undefined => {
  const pasted = event.clipboardData?.getData("text/plain") ?? "";
  const normalized = normalizePastedLists(pasted);
  return pasted && normalized !== pasted ? normalized : undefined;
};
