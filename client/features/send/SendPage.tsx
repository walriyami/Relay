import { LIMITS } from "../../api";
import { addSelection, getDraft, setText } from "../../lib/draft";
import { usePageDrop } from "../../components/PageDrop";
import { Composer } from "./Composer";
import { RecentGrid } from "../library/FilesPage";

export function SendPage() {
  // Dropping or pasting anywhere on Send adds to the selection; nothing uploads until a
  // destination is chosen.
  const overlay = usePageDrop({
    onFiles: (files, folders) => addSelection(files, folders),
    // Pasting text outside any input puts it in the message box (and starts the next transfer if a
    // finished one is showing). Text already being written is never replaced.
    onText: (text) => {
      if (getDraft().text.trim()) return false;
      setText(text.slice(0, LIMITS.textBytes));
      window.dispatchEvent(new Event("relay-show-text"));
      return true;
    },
    hint: "Nothing uploads until you choose where it goes.",
  });
  return (
    <div className="page">
      <div className="page-head send-head">
        <div>
          <h1>Send</h1>
          <p className="muted">
            Goes through Relay and is kept in your Files: share it with a link, or send it to your devices, even ones
            that are away.
          </p>
        </div>
      </div>
      <Composer>
        <RecentGrid />
      </Composer>
      {overlay}
    </div>
  );
}
