// Explicit one-time initialization, using the official public SDK.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const [project, source, sdkPath] = process.argv.slice(2);
if (!project || !source || !sdkPath) throw new Error('Usage: node scripts/init-project.js PROJECT SOURCE SDK_ENTRY');
const { LayerFS } = await import(pathToFileURL(resolve(sdkPath)).href);
const client = await LayerFS.init(project, resolve(source));
try { console.log(JSON.stringify(client.created)); }
finally { await client.close(); }
