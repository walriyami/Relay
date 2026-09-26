import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/features.css";
import { App } from "./app/App";
import { installFocusRecovery } from "./lib/focus";
import { installTabTitle } from "./lib/tab-title";
import { isBusy, subscribe, transfers } from "./lib/transfers";

installFocusRecovery();
installTabTitle(subscribe, () => transfers.filter(isBusy));

createRoot(document.getElementById("root")!).render(<App />);
