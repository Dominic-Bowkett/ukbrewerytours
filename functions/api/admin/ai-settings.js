// /api/admin/ai-settings — the Claude settings behind AI drafts.
//   GET    { key_set, key_hint, model, models, instructions, auto_draft, workspace_id } — never the key itself
//   PATCH  { api_key?, model?, instructions?, auto_draft?, workspace_id? } — a new key is checked with
//          Anthropic before it is saved (a model lookup: no tokens, no cost).

import {
  AI_MODELS, WORKSPACE_RE, aiConfig, loadApiKey, saveApiKey, setSetting, makeClient, explainAnthropicError,
} from '../../_lib/autoreply.js';

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
    workspace_id: cfg.workspaceId,
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
  // Saved before the key is checked, so the check runs against this workspace.
  if (body.workspace_id !== undefined) {
    const ws = String(body.workspace_id ?? '').trim();
    if (ws && !WORKSPACE_RE.test(ws)) return Response.json({ error: 'A Workspace ID starts wrkspc_ — copy it from console.anthropic.com → Settings → Workspaces.' }, { status: 400 });
    await setSetting(env, 'ai_workspace_id', ws || null);
  }
  if (body.api_key !== undefined) {
    const key = String(body.api_key ?? '').trim();
    if (key) {
      try {
        const cfg = await aiConfig(env);
        await makeClient(key, cfg.workspaceId, { timeout: 15000, maxRetries: 0 }).models.retrieve(cfg.model);
      } catch (err) {
        const explained = explainAnthropicError(err);
        if (explained) return Response.json({ error: explained }, { status: 400 });
        throw err;
      }
    }
    await saveApiKey(env, key || null);
  }
  return onRequestGet({ env });
}
