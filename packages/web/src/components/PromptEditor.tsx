import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { history, historyKeymap, insertNewline } from "@codemirror/commands";
import { EditorState, Prec, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder as placeholderExtension, type DecorationSet } from "@codemirror/view";
import { highlightSpans } from "@branchboard/core";
import { autoFormatTypedText, normalizedPaste } from "../typing";

export interface PromptEditorHandle {
  replace: (text: string, caret: number) => void;
}

interface PromptEditorProps {
  ref?: Ref<PromptEditorHandle>;
  value: string;
  className?: string;
  placeholder: string;
  autoFocus?: boolean;
  onChange: (text: string, caret: number) => void;
  onCaret?: (caret: number) => void;
  onBlur?: () => void;
  onKeyDown?: (event: KeyboardEvent) => boolean;
}

const hiddenBacktick = Decoration.replace({});
const inlineCode = Decoration.mark({ class: "cm-inline-code" });
const inlineCodeEditing = Decoration.mark({ class: "cm-inline-code is-editing" });

interface PlacedSpan {
  kind: string;
  from: number;
  to: number;
}

const placeSpans = (text: string): PlacedSpan[] => {
  let position = 0;
  return highlightSpans(text).map((span) => {
    const placed = { kind: span.kind, from: position, to: position + span.text.length };
    position = placed.to;
    return placed;
  });
};

const touches = (selection: { from: number; to: number }, from: number, to: number): boolean => selection.from <= to && selection.to >= from;

interface CodeLine extends PlacedSpan {
  lineNumber: number;
}

const codeLineGroups = (state: EditorState, spans: PlacedSpan[]): CodeLine[][] => {
  const groups: CodeLine[][] = [];
  for (const span of spans.filter((candidate) => candidate.kind === "fence-line" || candidate.kind === "block-code")) {
    const line = { ...span, lineNumber: state.doc.lineAt(span.from).number };
    const group = groups.at(-1);
    if (group && group.at(-1)!.lineNumber === line.lineNumber - 1) group.push(line);
    else groups.push([line]);
  }
  return groups;
};

const inlineCodeDecorations = (span: PlacedSpan, isEditing: boolean): Range<Decoration>[] =>
  isEditing
    ? [inlineCodeEditing.range(span.from, span.to)]
    : [hiddenBacktick.range(span.from, span.from + 1), inlineCode.range(span.from + 1, span.to - 1), hiddenBacktick.range(span.to - 1, span.to)];

const codeGroupDecorations = (group: CodeLine[], isEditing: boolean): Range<Decoration>[] =>
  group.map((line, index) => {
    const classes = ["cm-block-line", line.kind === "fence-line" ? "cm-fence-line" : "", index === 0 ? "is-first" : "", index === group.length - 1 ? "is-last" : "", isEditing ? "is-editing" : ""];
    return Decoration.line({ class: classes.filter(Boolean).join(" ") }).range(line.from);
  });

const buildDecorations = (state: EditorState): DecorationSet => {
  const spans = placeSpans(state.doc.toString());
  const selection = state.selection.main;
  const inline = spans.filter((span) => span.kind === "inline-code").flatMap((span) => inlineCodeDecorations(span, touches(selection, span.from, span.to)));
  const blocks = codeLineGroups(state, spans).flatMap((group) => codeGroupDecorations(group, touches(selection, group[0].from, group.at(-1)!.to)));
  return Decoration.set([...inline, ...blocks], true);
};

const codeDecorations = StateField.define<DecorationSet>({
  create: buildDecorations,
  update: (_previous, transaction) => buildDecorations(transaction.state),
  provide: (field) => EditorView.decorations.from(field),
});

export const PromptEditor = ({ ref, value, className, placeholder, autoFocus, onChange, onCaret, onBlur, onKeyDown }: PromptEditorProps) => {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const latest = useRef({ onChange, onCaret, onBlur, onKeyDown, value });
  latest.current = { onChange, onCaret, onBlur, onKeyDown, value };

  useEffect(() => {
    const created = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          history(),
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: (event) => latest.current.onKeyDown?.(event) ?? false,
              paste: (event, editor) => {
                const normalized = normalizedPaste(event);
                if (normalized === undefined) return false;
                event.preventDefault();
                editor.dispatch(editor.state.replaceSelection(normalized), { userEvent: "input.paste", scrollIntoView: true });
                return true;
              },
              blur: () => (latest.current.onBlur?.(), false),
            }),
          ),
          keymap.of([{ key: "Enter", run: insertNewline }, ...historyKeymap]),
          autoFormatTypedText,
          codeDecorations,
          placeholderExtension(placeholder),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ spellcheck: "true", "aria-label": placeholder }),
          EditorView.updateListener.of((update) => {
            const caret = update.state.selection.main.head;
            if (update.docChanged) latest.current.onChange(update.state.doc.toString(), caret);
            if (update.docChanged || update.selectionSet) latest.current.onCaret?.(caret);
          }),
        ],
      }),
    });
    view.current = created;
    if (autoFocus) {
      created.focus();
      created.dispatch({ selection: { anchor: created.state.doc.length } });
    }
    return () => created.destroy();
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  useImperativeHandle(ref, () => ({
    replace: (text, caret) => {
      const editor = view.current;
      if (!editor) return;
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, selection: { anchor: caret }, userEvent: "pick" });
      editor.focus();
    },
  }));

  return <div ref={host} className={`prompt-editor nodrag nowheel ${className ?? ""}`} />;
};
