import type { ReactNode } from "react";

export const Selectable = ({ children }: { children: ReactNode }) => <span className="copyable text-run nodrag">{children}</span>;
