// /api/admin/ai-settings — the Claude settings behind AI drafts.
//   GET    { key_set, key_hint, model, models, instructions, auto_draft } — never the key itself
//   PATCH  { api_key?, model?, instructions?, auto_draft? } — a new key is checked with
//          Anthropic before it is saved (a model lookup: no tokens, no cost).

import Anthropic from '@anthropic-ai/sdk';
import { AI_MODELS, aiConfig, loadApiKey, saveApiKey, setSetting } from '../../_lib/autoreply.js';

export async function onRequestGet({ env }) {
  const key = await loadApiKey(env);
  const cfg = await aiConfig(env);
  return Response.json({
    key_set: Boolean(key),
    key_hint: key ? `…${key.slice(-4)}` : null,
    model: cfg.model,
    models: AI_MODELS,
    instructions: cfg.instructions,
    auto_draft: cfg.autoDraft,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function onRequestPatch({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request.' }, { status: 400 }); }

  if (body.model !== undefined) {
    if (!AI_MODELS[body.model]) return Response.json({ error: 'Unknown model.' }, { status: 400 });
    await setSetting(env, 'ai_model', body.model);
  }
  if (body.instructions !== undefined) {
    await setSetting(env, 'ai_instructions', String(body.instructions ?? '').slice(0, 20000));
  }
  if (body.auto_draft !== undefined) {
    await setSetting(env, 'ai_auto_draft', body.auto_draft ? '1' : '0');
  }
  if (body.api_key !== undefined) {
    const key = String(body.api_key ?? '').trim();
    if (key) {
      try {
        const cfg = await aiConfig(env);
        await new Anthropic({ apiKey: key, timeout: 15000, maxRetries: 0 }).models.retrieve(cfg.model);
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) return Response.json({ error: 'Anthropic did not accept that API key.' }, { status: 400 });
        if (err instanceof Anthropic.PermissionDeniedError) return Response.json({ error: 'That key cannot use the chosen model.' }, { status: 400 });
        if (err instanceof Anthropic.APIConnectionError) return Response.json({ error: 'Could not reach Anthropic to check the key — try again.' }, { status: 502 });
        if (err instanceof Anthropic.APIError) return Response.json({ error: `Anthropic: ${String(err.message).slice(0, 200)}` }, { status: 400 });
        throw err;
      }
    }
    await saveApiKey(env, key || null);
  }
  return onRequestGet({ env });
}
