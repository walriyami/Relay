import type { ReactNode } from "react";
import { Download, Eye, FolderInput, KeyRound, LogIn, ShieldCheck, ShieldOff, UserPlus, X } from "lucide-react";
import type { ActivityEntry, Delivery, SignInMethod } from "../../api";
import { bytes, plural } from "../../lib/format";
import { UserText } from "../../components/UserText";

export type Described = { icon: ReactNode; title: ReactNode; detail: ReactNode; tone?: "warn" };

const METHOD: Record<SignInMethod, string> = {
  sso: "Signed in with Walriyami",
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
      // A new kind of device is worth a look; a familiar one signing in again is routine.
      return e.news
        ? {
            icon: <LogIn size={16} />,
            title: (
              <>
                New sign-in on <UserText>{e.device}</UserText>
              </>
            ),
            detail: `${METHOD[e.method]} · Not you? Sign it out in Settings`,
            tone: "warn",
          }
        : {
            icon: <LogIn size={16} />,
            title: e.self ? (
              "This device signed in"
            ) : (
              <>
                <UserText>{e.device}</UserText> signed in
              </>
            ),
            detail: METHOD[e.method],
          };
    case "password":
      return e.device === null
        ? {
            icon: <KeyRound size={16} />,
            title: "The administrator set a new password for you",
            detail: "Your devices were signed out",
            tone: "warn",
          }
        : {
            icon: <KeyRound size={16} />,
            title: "Your password was changed",
            detail: e.self ? (
              "On this device · Your other devices were signed out"
            ) : (
              <>
                On <UserText>{e.device}</UserText>
              </>
            ),
            tone: e.self ? undefined : "warn",
          };
    case "passkey":
      return {
        icon: e.change === "added" ? <ShieldCheck size={16} /> : <ShieldOff size={16} />,
        title: (
          <>
            Passkey “<UserText>{e.name}</UserText>” {e.change === "added" ? "added" : "removed"}
          </>
        ),
        detail: e.self ? "On this device" : "On another device",
      };
    case "upload":
      return {
        icon: <FolderInput size={16} />,
        title: (
          <>
            {e.sender ? <UserText>{e.sender}</UserText> : "Someone"} sent {!e.files && e.text ? "text" : "files"} to “
            <UserText>{e.request}</UserText>”
          </>
        ),
        detail: contents(e.files, e.bytes, e.text),
      };
    case "link":
      // One entry per person: when they first open the link, and when they first download from it.
      return e.action === "opened"
        ? {
            icon: <Eye size={16} />,
            title: (
              <>
                Your link to “<UserText>{e.item}</UserText>” was opened
              </>
            ),
            detail: (
              <>
                On <UserText>{e.device}</UserText>
              </>
            ),
          }
        : {
            icon: <Download size={16} />,
            title: (
              <>
                “<UserText>{e.item}</UserText>” was downloaded with your link
              </>
            ),
            detail: (
              <>
                On <UserText>{e.device}</UserText>
              </>
            ),
          };
    case "joined":
      return {
        icon: <UserPlus size={16} />,
        title: e.walriyami
          ? `${e.username} joined by signing in with Walriyami`
          : `${e.username} joined with your invitation`,
        detail: e.note ? (
          <>
            Invitation: <UserText>{e.note}</UserText>
          </>
        ) : (
          "New member"
        ),
      };
  }
}

/** A delivery this device answered, as a line in the Activity list. */
export function describeAnswered(d: Delivery): Described {
  const from = d.from?.name ? <UserText>{d.from.name}</UserText> : "another device";
  const accepted = d.state === "accepted";
  return {
    icon: accepted ? <Download size={16} /> : <X size={16} />,
    title: (
      <>
        “<UserText>{d.item?.name || "Removed item"}</UserText>” from {from}
      </>
    ),
    detail: accepted ? "Accepted" : "Declined · still in your Files",
  };
}

/** What a pending delivery holds: "3 files · 2 MB", "Text". */
export function describeDelivery(d: Delivery) {
  if (!d.item) return "";
  return d.item.files ? `${plural(d.item.files, "file")} · ${bytes(d.item.bytes)}` : "Text";
}
