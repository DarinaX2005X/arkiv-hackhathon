import { createArkivReadHandler } from '../src/server/arkiv-read.js';

const handler = createArkivReadHandler({ accessKey: () => process.env.ARKIV_RPC_ACCESS_KEY });

// Vercel's Node.js Web Standard entry point; the key is read only inside server requests.
export default { fetch: handler };
