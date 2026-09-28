import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { PdfPreview } from "../../client/components/PdfPreview";
import { DeviceCode } from "../../client/features/settings/AddDevice";
import { pdfThumbnail } from "../../client/lib/pdf";
import "../../client/styles/tokens.css";
import "../../client/styles/base.css";
import "../../client/styles/components.css";
import "../../client/styles/features.css";

function Fixture() {
  const [open, setOpen] = useState(true);
  const [url, setUrl] = useState("/fixture.pdf");
  const [failed, setFailed] = useState(false);
  const [thumbnail, setThumbnail] = useState("");
  const [finished, setFinished] = useState(0);
  const device = new URLSearchParams(location.search).has("device");
  return (
    <>
      <button onClick={() => setOpen(!open)}>Toggle</button>
      <button onClick={() => setUrl(url === "/fixture.pdf" ? "/second.pdf" : "/fixture.pdf")}>Change file</button>
      <button
        onClick={async () => {
          const response = await fetch("/fixture.pdf");
          const blob = await response.blob();
          const file = new File([blob], "fixture.pdf");
          setThumbnail(await pdfThumbnail(file, "", file.size));
          setFinished((count) => count + 1);
        }}
      >
        Thumbnail
      </button>
      {thumbnail && (
        <>
          <img src={thumbnail} alt="PDF thumbnail" />
          <p role="status">Thumbnails finished: {finished}</p>
        </>
      )}
      {failed && <p role="alert">Preview failed</p>}
      <div style={{ width: "min(100%, 1200px)", margin: "auto" }}>
        {open &&
          (device ? (
            <DeviceCode added={() => <p>Done</p>} />
          ) : (
            <PdfPreview url={url} name="Long PDF" onFailed={() => setFailed(true)} />
          ))}
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  new URLSearchParams(location.search).has("strict") ? (
    <StrictMode>
      <Fixture />
    </StrictMode>
  ) : (
    <Fixture />
  ),
);
