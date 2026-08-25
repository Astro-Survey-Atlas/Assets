import { FileCode2, GitBranch, Home, Telescope, createIcons } from "lucide";
import { mountLocaleControls } from "./i18n.js";

mountLocaleControls();
createIcons({ icons: { FileCode2, GitBranch, Home, Telescope }, attrs: { "aria-hidden": "true" } });
