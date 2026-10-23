export const listenForEscape = (close: () => void): (() => void) => {
  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
  };
  window.addEventListener("keydown", closeOnEscape, true);
  return () => window.removeEventListener("keydown", closeOnEscape, true);
};
