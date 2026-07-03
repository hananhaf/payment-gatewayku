// Plain-JS entry point for host platforms that start the app with `node server.js`
// (e.g. Hostinger Node.js Web App). Local/Docker use `npm start` (tsx src/main.ts).
//
// Boots the TypeScript app via tsx, then background-builds the frontend if dist/
// is missing. Verbose startup logging so a host's runtime log shows exactly what
// happened (which port was assigned, any crash) instead of a silent 503.
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

console.log(
  `[server.js] boot: node ${process.version} | PORT=${process.env.PORT ?? "(unset)"} | cwd=${process.cwd()}`
);

process.on("uncaughtException", (err) => {
  console.error("[server.js] uncaughtException:", err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("[server.js] unhandledRejection:", err);
  process.exit(1);
});

try {
  const { register } = await import("tsx/esm/api");
  register();
  await import("./src/main.ts");
  console.log("[server.js] main.ts loaded — server should now be listening");
} catch (err) {
  console.error("[server.js] FATAL during startup:", err);
  process.exit(1);
}

if (!existsSync("./dist/checkout.html")) {
  console.log("[server.js] dist/ missing — building frontend in the background...");
  const build = spawn("npm", ["run", "build"], { stdio: "inherit" });
  build.on("exit", (code) =>
    console.log(
      code === 0
        ? "[server.js] frontend build complete — checkout page now available"
        : `[server.js] frontend build failed (exit ${code}); API/webhook still running`
    )
  );
}
