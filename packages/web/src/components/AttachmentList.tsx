import { isTextAttachment, type Attachment, type GraphNode } from "@branchboard/core";
import { attachmentUrl } from "../api";
import { attachToNode, detachFromNode, fileTypeLabel, formatBytes, isDisplayableImage, pickFiles } from "../attachments";
import { ExtractAttachmentButton } from "./CodeNode";
import { Icon } from "./Icons";
import { PreviewableImage } from "./ImagePreview";

const RemoveButton = ({ node, attachment }: { node: GraphNode; attachment: Attachment }) => (
  <button className="remove" title="Remove" aria-label={`Remove ${attachment.name}`} onClick={() => void detachFromNode(node.id, attachment.id)}>×</button>
);

const AttachmentChip = ({ node, attachment, isEditable }: { node: GraphNode; attachment: Attachment; isEditable: boolean }) => (
  <div className="attachment-chip nodrag">
    {isDisplayableImage(attachment) ? (
      <PreviewableImage url={attachmentUrl(attachment.id)} name={attachment.name}>
        <img src={attachmentUrl(attachment.id)} alt="" loading="lazy" />
        <span className="attachment-name">{attachment.name}</span>
      </PreviewableImage>
    ) : (
      <a href={attachmentUrl(attachment.id)} target="_blank" rel="noreferrer" title={`${attachment.name} (${formatBytes(attachment.size)})`}>
        <Icon name="file" />
        <span className="attachment-name">{attachment.name}</span>
      </a>
    )}
    {isEditable && <RemoveButton node={node} attachment={attachment} />}
  </div>
);

export const AttachButton = ({ node, label }: { node: GraphNode; label?: string }) => (
  <button className="attach-button nodrag" title="Attach files (or drop them on this node)" aria-label="Attach files" onClick={() => void pickFiles().then((files) => attachToNode(node.id, files))}>
    <Icon name="paperclip" />
    {label}
  </button>
);

export const AttachmentList = ({ node, isEditable }: { node: GraphNode; isEditable: boolean }) => {
  const attachments = node.attachments ?? [];
  if (attachments.length === 0) return null;
  return (
    <div className="attachment-list nowheel">
      {attachments.map((attachment) => <AttachmentChip key={attachment.id} node={node} attachment={attachment} isEditable={isEditable} />)}
    </div>
  );
};

const FileTile = ({ node, attachment }: { node: GraphNode; attachment: Attachment }) => (
  <div className="file-tile nodrag">
    {isDisplayableImage(attachment) ? (
      <PreviewableImage url={attachmentUrl(attachment.id)} name={attachment.name}>
        <img src={attachmentUrl(attachment.id)} alt={attachment.name} loading="lazy" />
      </PreviewableImage>
    ) : (
      <a href={attachmentUrl(attachment.id)} target="_blank" rel="noreferrer" title={attachment.name}>
        <div className="file-plaque">
          <span className="file-plaque-icon"><Icon name="file" /></span>
          <span className="file-plaque-text">
            <span className="file-plaque-name">{attachment.name}</span>
            <span className="file-plaque-meta">{fileTypeLabel(attachment)} · {formatBytes(attachment.size)}</span>
          </span>
        </div>
      </a>
    )}
    {isTextAttachment(attachment) && <ExtractAttachmentButton attachment={attachment} />}
    <RemoveButton node={node} attachment={attachment} />
  </div>
);

export const FileGallery = ({ node }: { node: GraphNode }) => {
  const attachments = node.attachments ?? [];
  if (attachments.length === 0) return <div className="file-empty">Drop files here</div>;
  return (
    <div className={`file-gallery nowheel ${attachments.length === 1 ? "is-single" : ""}`}>
      {attachments.map((attachment) => <FileTile key={attachment.id} node={node} attachment={attachment} />)}
    </div>
  );
};
