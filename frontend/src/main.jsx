import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";

/**
 * Deliberately NOT wrapped in StrictMode.
 *
 * StrictMode double-mounts every component in development. IDKit's request flow
 * is a polling bridge: mounting opens a session, World App answers that specific
 * session, and the second mount can leave the app polling a different one. The
 * proof then lands nowhere — World App reports success while no callback fires
 * and the console stays empty.
 *
 * The production build never double-mounts, so this only removes a
 * development-only source of a bug that does not exist in production.
 */
createRoot(document.getElementById("root")).render(<App />);
