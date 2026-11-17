import { FolderOpen, Radar, Send } from "lucide-react";
import { Icon } from "../components/icons";

/** The main sections, as the header and the phone tab bar list them. */
export const NAV = [
  { to: "/", label: "Send", icon: <Send size={20} aria-hidden /> },
  { to: "/nearby", label: "Nearby", icon: <Radar size={20} aria-hidden /> },
  { to: "/files", label: "Files", icon: <FolderOpen size={20} aria-hidden /> },
  { to: "/links", label: "Links", icon: <Icon.link size={20} aria-hidden /> },
  { to: "/requests", label: "Requests", icon: <Icon.request size={20} aria-hidden /> },
];

/** "/files/abc" → "/files". */
export const sectionOf = (route: string) => "/" + (route.split("/")[1] || "");

/** Whether a nav entry is the current section: Trash belongs to Files. */
export const isCurrent = (to: string, section: string) => section === to || (to === "/files" && section === "/trash");
