import { buildApp } from "./app-factory.ts";

const { app, config } = await buildApp();

app.listen(config.port, () => {
  console.log(`QRIS gateway listening on :${config.port}`);
  console.log(`  checkout: http://localhost:${config.port}/checkout.html`);
  console.log(`  webhook:  http://localhost:${config.port}/webhook`);
});
