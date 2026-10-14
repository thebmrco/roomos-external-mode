/**
 * Cloudflare Worker: serves the static web app (assets in ./webapp) and
 * handles POST /api/help by sending an email through Cloudflare Email
 * Routing (send_email binding — no third-party mail service).
 *
 * Service types, labels and email wording come from webapp/config.json
 * (read through the ASSETS binding). Recipient addresses are NOT in
 * config.json, because that file is publicly served — they live in the
 * Worker vars instead:
 *
 *   HELP_FROM            sender address on the Email Routing zone
 *   HELP_TO              fallback recipient
 *   HELP_TO_<SERVICE_ID> per-service recipient, e.g. HELP_TO_TECH
 *   HELP_TOKEN           shared token (set with `wrangler secret put`)
 */
import { EmailMessage } from 'cloudflare:email';

/* Minimal RFC 5322 message with UTF-8 handled via base64 encoding */
function buildMime({ from, to, subject, text }) {
  const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const encodedSubject = `=?utf-8?B?${b64(subject)}?=`;
  const messageId = `<${crypto.randomUUID()}@${from.split('@')[1]}>`;
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text),
    '',
  ].join('\r\n');
}

/* "{room} – {issue}" style templating; unknown keys become empty */
function fill(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
}

/* "tech" → HELP_TO_TECH, "front-desk" → HELP_TO_FRONT_DESK */
function recipientVar(serviceId) {
  return 'HELP_TO_' + serviceId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

async function loadConfig(request, env) {
  const res = await env.ASSETS.fetch(new URL('/config.json', request.url));
  if (!res.ok) throw new Error('config.json: HTTP ' + res.status);
  return res.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/help' && request.method === 'POST') {
      return handleHelp(request, env);
    }

    // Static assets are served automatically before the Worker runs;
    // anything that reaches this point is an unknown route.
    return new Response('Not found', { status: 404 });
  },
};

async function handleHelp(request, env) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  if (!env.HELP_EMAIL || !env.HELP_TO || !env.HELP_FROM) {
    return json({ error: 'not configured' }, 500);
  }

  // shared-token gate: only the room device (macro/webview) knows the token
  if (env.HELP_TOKEN && request.headers.get('X-Room-Token') !== env.HELP_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }

  let cfg;
  try {
    cfg = await loadConfig(request, env);
  } catch (e) {
    console.log('config load failed:', e.message);
    return json({ error: 'config unavailable' }, 500);
  }

  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    // no/invalid body — handled below
  }
  const str = (v) => (typeof v === 'string' ? v.trim().slice(0, 100) : '');

  const service = (cfg.services || []).find((s) => s.id === body.type);
  if (!service) return json({ error: 'unknown service' }, 400);

  const room = str(body.room) || cfg.roomFallback || 'Unknown room';
  const issue = str(body.issue);
  const name = str(body.name);

  const to = env[recipientVar(service.id)] || env.HELP_TO;
  const time = new Date().toLocaleString(cfg.locale || 'en-GB', { timeZone: cfg.timeZone || 'UTC' });
  const e = cfg.email || {};
  const vars = { service: service.label, room, issue, name, time, issue_suffix: issue ? ` – ${issue}` : '' };
  vars.issue_line = issue ? fill(e.issueLine || 'Request: {issue}\n', vars) : '';
  vars.name_line = name ? fill(e.nameLine || 'Name: {name}\n', vars) : '';

  const raw = buildMime({
    from: env.HELP_FROM,
    to,
    subject: fill(e.subject || '{service} requested: {room}{issue_suffix}', vars),
    text: fill(e.body || '{service} requested in "{room}".\n\n{issue_line}{name_line}Time: {time}\n', vars),
  });

  try {
    await env.HELP_EMAIL.send(new EmailMessage(env.HELP_FROM, to, raw));
  } catch (err) {
    console.log('send_email failed:', err.message);
    return json({ error: 'send failed' }, 502);
  }

  return json({ ok: true });
}
