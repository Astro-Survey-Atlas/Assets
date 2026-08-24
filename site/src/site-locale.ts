import { Home, createIcons } from "lucide";
import { mountLocaleControls } from "./i18n.js";

mountLocaleControls();
createIcons({ icons: { Home }, attrs: { "aria-hidden": "true" } });
