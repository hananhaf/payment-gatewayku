// Plain-JS entry point for host platforms that start the app with `node server.js`
// (e.g. Hostinger Node.js Web App). Local/Docker use `npm start` (tsx src/main.ts)
// instead — see package.json.
//
// Two jobs:
//   1. Ensure the frontend is built (dist/) so the checkout page can be served.
//      If a build isn't possible at runtime the server still boots — the API and
//      webhook don't need dist/, only the checkout UI does.
//   2. Register tsx's on-the-fly TypeScript loader, then hand off to src/main.ts.
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { register } from "tsx/esm/api";

if (!existsSync("./dist/checkout.html")) {
  try {
    console.log("dist/ missing — building frontend (npm run build)...");
    execSync("npm run build", { stdio: "inherit" });
  } catch (err) {
    console.error(
      "Frontend build failed; starting API/webhook without the checkout page:",
      err.message
    );
  }
}

register();
await import("./src/main.ts");
