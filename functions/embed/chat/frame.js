// GET /embed/chat/frame?site=ukbt|london|bristol&host=<page url>
//
// The pop-up chat, loaded in a fixed bottom-right iframe by /embed/chat.js on
// every network site. Served from ukbrewerytours.com so its API calls are
// same-origin — the host sites need no CORS. Public by design: all it can do
// is start a conversation or continue one the browser already holds a token for.

import { chatHtml, PROFILES } from '../../_lib/chat-ui.js';

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const site = url.searchParams.get('site') || 'ukbt';
  const host = url.searchParams.get('host') || '';

  return new Response(chatHtml({ mode: 'frame', profileKey: PROFILES[site] ? site : 'ukbt', hostUrl: host }), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
