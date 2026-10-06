import { useCallback, useEffect, useRef, useState } from "react";

const AUTOSAVE_DELAY_MS = 600;

export const useAutosavedText = (savedText: string, save: (text: string) => void) => {
  const [text, setText] = useState(savedText);
  const latest = useRef({ text, savedText, save });
  latest.current = { text, savedText, save };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isDirty = useRef(false);

  const discard = useCallback(() => {
    clearTimeout(timer.current);
    isDirty.current = false;
  }, []);

  const flush = useCallback(() => {
    if (!isDirty.current) return;
    discard();
    const current = latest.current;
    if (current.text !== current.savedText) current.save(current.text);
  }, [discard]);

  useEffect(() => {
    if (!isDirty.current) setText(savedText);
  }, [savedText]);

  useEffect(() => flush, [flush]);

  const change = (next: string) => {
    isDirty.current = true;
    setText(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_DELAY_MS);
  };

  return { text, change, flush, discard };
};
