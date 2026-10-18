import { fileNameOf } from "@branchboard/core";
import { useChatHost } from "./host";
import { Icon } from "./Icons";

export const ExtractFileButton = ({ path }: { path: string }) => {
  const { extractFile } = useChatHost();
  if (!extractFile) return null;
  const label = `Extract ${fileNameOf(path)} into a code node`;
  return (
    <button
      className="extract-file nodrag"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        extractFile(path, event.currentTarget);
      }}
    >
      <Icon name="extract" />
    </button>
  );
};
