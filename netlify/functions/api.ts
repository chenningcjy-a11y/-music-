import { handleApiWebRequest } from '../../server/ai/httpRouterCore.ts';

/**
 * Netlify Functions v2 entry point handling all `/api/*` requests via `netlify.toml` rewrite.
 * Shares 100% of the AI adapter, lyrics translation, cover proxy, and encrypted vault logic
 * with the Express server (`server.ts`).
 */
export default async function handler(req: Request): Promise<Response> {
  try {
    return await handleApiWebRequest(req);
  } catch (err) {
    return new Response(
      JSON.stringify({
        error:
          err instanceof Error
            ? `服务端接口异常: ${err.message}`
            : '服务端接口异常，请稍后重试',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }
    );
  }
}
