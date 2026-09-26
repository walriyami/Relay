import type { ReactNode } from "react";
import { Button, Modal } from "./ui";
import { ShareAccess } from "./ShareAccess";

// The modal wrapper for shareable invitations and upload requests.
export function LinkDialog({
  title,
  subtitle,
  meta,
  url,
  code,
  codeLabel,
  purpose,
  actions,
  onClose,
}: {
  title: string;
  subtitle: string;
  meta?: ReactNode;
  url: string;
  code: string;
  codeLabel?: string;
  purpose?: string;
  actions?: ReactNode;
  onClose: () => void;
}) {
  return (
    <Modal
      size="sm"
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <ShareAccess url={url} code={code} codeLabel={codeLabel} purpose={purpose} detail={meta} actions={actions} />
    </Modal>
  );
}
