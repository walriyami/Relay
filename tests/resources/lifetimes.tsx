import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Button, Modal, Toaster, toast } from "../../client/components/ui";
import { pdfThumbnail } from "../../client/lib/pdf";
import "../../client/styles/tokens.css";
import "../../client/styles/base.css";
import "../../client/styles/components.css";

declare global {
  interface Window {
    thumbnailResults: { images: string[]; errors: string[] };
    startThumbnail: (bytes: number[]) => void;
    remountToaster: () => void;
    pdfMessages: { documentRequests: number; terminationRequests: number };
    dropPdfDocument?: boolean;
    dropPdfTerminate?: boolean;
  }
}
window.thumbnailResults = { images: [], errors: [] };
window.startThumbnail = (bytes) => {
  const file = new File([new Uint8Array(bytes)], "fixture.pdf");
  void pdfThumbnail(file, "", file.size).then(
    (image) => window.thumbnailResults.images.push(image),
    (error: Error) => window.thumbnailResults.errors.push(error.message),
  );
};
function Fixture() {
  const [generation, setGeneration] = useState(0);
  window.remountToaster = () => flushSync(() => setGeneration((value) => value + 1));
  useLayoutEffect(() => {
    if (generation) document.querySelector<HTMLButtonElement>(".toaster button")?.focus();
  }, [generation]);
  const content = (
    <>
      <Button onClick={() => toast("Keep reading", { timeout: 1000 })}>Add notice</Button>
      <input aria-label="Field" />
    </>
  );
  return (
    <>
      <Toaster key={generation} />
      {new URLSearchParams(location.search).has("modal") ? (
        <Modal title="Fixture" onClose={() => {}}>
          {content}
        </Modal>
      ) : (
        content
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
