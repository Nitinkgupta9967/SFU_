import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const { app } = await createApp(config);

await app.listen({ port: config.port, host: '0.0.0.0' });
