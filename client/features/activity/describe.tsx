import type { ReactNode } from "react";
import { Download, Eye, FolderInput, KeyRound, LogIn, ShieldCheck, ShieldOff, UserPlus, X } from "lucide-react";
import type { ActivityEntry, Delivery, SignInMethod } from "../../api";
import { bytes, plural } from "../../lib/format";

export type Described = { icon: ReactNode; title: string; detail: string; tone?: "warn" };

const METHOD: Record<SignInMethod, string> = {
  setup: "By setting up Relay",
  password: "With a password",
  passkey: "With a passkey",
  code: "With a sign-in code",
  invitation: "By accepting an invitation",
};

/** "3 files · 2 MB and text" */
function contents(files: number, size: number, text: boolean) {
  const parts = files ? `${plural(files, "file")} · ${bytes(size)}` : "";
  return text ? (parts ? `${parts} and text` : "Text") : parts || "Nothing";
}

/** One activity entry in words, for the Activity list. */
export function describeEntry(e: ActivityEntry): Described {
  switch (e.kind) {
    case "signin":
      return {
        icon: <LogIn size={16} />,
        title: e.self ? "This device signed in" : `${e.device} signed in`,
        detail: METHOD[e.method],
      };
    case "password":
      return e.device === null
        ? {
            icon: <KeyRound size={16} />,
            title: "The administrator set a new password",
            detail: "Your other devices were signed out",
            tone: "warn",
          }
        : {
            icon: <KeyRound size={16} />,
            title: "Password changed",
            detail: e.self ? "On this device" : `On ${e.device}`,
          };
    case "passkey":
      return {
        icon: e.change === "added" ? <ShieldCheck size={16} /> : <ShieldOff size={16} />,
        title: e.change === "added" ? `Passkey “${e.name}” added` : `Passkey “${e.name}” removed`,
        detail: e.self ? "On this device" : "On another device",
      };
    case "upload":
      return {
        icon: <FolderInput size={16} />,
        title: `${e.sender || "Someone"} sent files to “${e.request}”`,
        detail: contents(e.files, e.bytes, e.text),
      };
    case "link":
      // One entry per person: when they first open the link, and when they first download from it.
      return e.action === "opened"
        ? { icon: <Eye size={16} />, title: `Someone opened “${e.item}”`, detail: `${e.device} · with your link` }
        : {
            icon: <Download size={16} />,
            title: `Someone downloaded “${e.item}”`,
            detail: `${e.device} · with your link`,
          };
    case "joined":
      return {
        icon: <UserPlus size={16} />,
        title: `${e.username} joined with your invitation`,
        detail: e.note ? `Invitation: ${e.note}` : "New member",
      };
  }
}

/** A delivery this device answered, as a line in the Activity list. */
export function describeAnswered(d: Delivery): Described {
  const from = d.from?.name || "another device";
  const accepted = d.state === "accepted";
  return {
    icon: accepted ? <Download size={16} /> : <X size={16} />,
    title: `“${d.item?.name || "Removed item"}” from ${from}`,
    detail: accepted ? "Accepted" : "Declined · still in your Files",
  };
}

/** What a pending delivery holds: "3 files · 2 MB", "Text". */
export function describeDelivery(d: Delivery) {
  if (!d.item) return "";
  return d.item.files ? `${plural(d.item.files, "file")} · ${bytes(d.item.bytes)}` : "Text";
}
