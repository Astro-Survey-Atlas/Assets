import { ArrowDown, ArrowDownUp, ArrowRight, ArrowUp, Boxes, Database, ExternalLink, FileCode2, GitBranch, Globe2, Home, PanelsTopLeft, Signpost, Telescope, Users, createIcons } from "lucide";
import { mountLocaleControls } from "./i18n.js";
import { mountSiteChrome } from "./site-chrome.js";

mountLocaleControls();
mountSiteChrome();
createIcons({
  icons: { ArrowDown, ArrowDownUp, ArrowRight, ArrowUp, Boxes, Database, ExternalLink, FileCode2, GitBranch, Globe2, Home, PanelsTopLeft, Signpost, Telescope, Users },
  attrs: { "aria-hidden": "true" },
  root: document.querySelector("main") ?? document.body,
});
