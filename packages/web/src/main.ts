import "./style.css";
import { addRoute, startRouter } from "./router.js";
import { renderFeedPage } from "./pages/feed.js";
import { renderSearchPage } from "./pages/search.js";
import { renderLoginPage } from "./pages/login.js";
import { renderRegisterPage } from "./pages/register.js";
import { renderBlogPage } from "./pages/blog.js";
import { renderBlogFeedPage } from "./pages/blogFeed.js";
import { renderPostPage } from "./pages/post.js";
import { renderEditorPage } from "./pages/editor.js";
import { renderAdminPage } from "./pages/admin.js";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app root element is missing from index.html");

addRoute("/", () => void renderFeedPage(app));
addRoute("/search", () => renderSearchPage(app));
addRoute("/login", () => renderLoginPage(app));
addRoute("/register", () => renderRegisterPage(app));
addRoute("/admin", () => void renderAdminPage(app));
addRoute("/blog/:username/feed", (params) => void renderBlogFeedPage(app, params.username!));
addRoute("/blog/:username", (params) => void renderBlogPage(app, params.username!));
addRoute("/posts/:slug/edit", (params) => void renderEditorPage(app, params.slug!));
addRoute("/posts/:slug", (params) => void renderPostPage(app, params.slug!));
addRoute("/new", () => void renderEditorPage(app));

startRouter();
