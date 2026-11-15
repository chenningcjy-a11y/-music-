import { handleApiWebRequest } from '../../server/ai/httpRouterCore.ts';

/**
 * Netlify Functions v2 entry point handling all `/api/*` requests via `netlify.toml` rewrite.
 * Shares 100% of the AI adapter, lyrics translation, cover proxy, and encrypted vault logic
 * with the Express server (`server.ts`).
 */
export default async function handler(req: Request): Promise<Response> {
  return handleApiWebRequest(req);
}
