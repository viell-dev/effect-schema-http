import { defineConfig } from "vite";

// WEBrick's automatic OPTIONS responses have no CORS headers. Preserve every service
// path through a same-origin proxy so HMAC signs the exact path Ruby receives.
const proxy = {
  "^/(session(?:/|$)|notifications(?:[./]|$)|inbox(?:/|$)|legacy/notifications(?:/|$)|throttled(?:/|$))": {
    target: "http://localhost:4500",
    changeOrigin: true,
  },
};

export default defineConfig({
  server: { port: 5173, proxy },
  preview: { proxy },
});
