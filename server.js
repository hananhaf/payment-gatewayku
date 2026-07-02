// Plain-JS entry point for host platforms that start the app with `node server.js`
// (e.g. Hostinger Node.js Web App). Local/Docker use `npm start` (tsx src/main.ts).
//
// Boot the TypeScript app immediately so the port binds fast (host startup health
// checks). If the frontend isn't built yet, build it in the BACKGROUND — blocking
// on the build would delay the port bind and can trip a startup timeout. The API
// and webhook work without dist/; only the checkout page needs it, and it starts
// serving as soon as the background build finishes (express.static reads per-request).
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { register } from "tsx/esm/api";

register();
await import("./src/main.ts");

if (!existsSync("./dist/checkout.html")) {
  console.log("dist/ missing — building frontend in the background (npm run build)...");
  const build = spawn("npm", ["run", "build"], { stdio: "inherit" });
  build.on("exit", (code) =>
    console.log(
      code === 0
        ? "frontend build complete — checkout page now available"
        : `frontend build failed (exit ${code}); API/webhook still running`
    )
  );
}
