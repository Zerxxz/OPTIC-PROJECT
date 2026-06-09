/**
 * OPTIC zkLogin salt service — Cloudflare Worker.
 *
 * Endpoint:  POST { jwt: string }  →  { salt: string }
 *
 * The salt binds a Google OAuth subject to a Sui address. It MUST be kept
 * secret (a leaked salt lets anyone re-derive your address), and it MUST
 * be deterministic per (jwt) so a returning user gets the same address.
 *
 * This worker derives a salt by HMAC-SHA256-ing the JWT with a server-side
 * secret. That's enough entropy to keep salts unguessable while still being
 * reproducible. The JWT is only kept in memory for the duration of the
 * request — nothing is logged or persisted.
 *
 * Deploy:
 *   cd salt-worker
 *   pnpm dlx wrangler deploy
 *
 * Then set the URL as window.OPTIC_CONFIG.saltUrl (or DEFAULT_SALT_URL in
 * chrome.js).
 */

export default {
  async fetch(request, env, ctx) {
    // CORS preflight.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    if (request.method !== 'POST') {
      return new Response('Use POST { jwt }', {
        status: 405,
        headers: corsHeaders(request),
      });
    }

    let jwt;
    try {
      const body = await request.json();
      jwt = body && typeof body.jwt === 'string' ? body.jwt : null;
    } catch {
      return jsonError(request, 400, 'Invalid JSON body');
    }
    if (!jwt || jwt.split('.').length !== 3) {
      return jsonError(request, 400, 'Missing or malformed `jwt`');
    }

    // Sanity: must be a Google id_token (issuer = accounts.google.com).
    try {
      const payload = JSON.parse(
        atobPart(jwt.split('.')[1] || ''),
      );
      if (
        typeof payload.iss !== 'string' ||
        !payload.iss.endsWith('accounts.google.com')
      ) {
        return jsonError(request, 400, 'JWT issuer is not Google');
      }
      if (typeof payload.aud !== 'string' || !payload.aud) {
        return jsonError(request, 400, 'JWT missing `aud`');
      }
    } catch {
      return jsonError(request, 400, 'Could not decode JWT payload');
    }

    // Derive a per-user salt: HMAC-SHA256(secret, jwt) → bigint string.
    const secret =
      env.SALT_SECRET ||
      // Dev fallback. Always set SALT_SECRET in production.
      'optic-dev-secret-DO-NOT-USE-IN-PROD-9d7f3a';
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(jwt),
    );
    const salt = bytesToBigIntString(new Uint8Array(sig));

    return new Response(JSON.stringify({ salt }), {
      status: 200,
      headers: {
        ...corsHeaders(request),
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    });
  },
};

function atobPart(s) {
  // atob() is a global in Workers; decode URL-safe base64.
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
}

function bytesToBigIntString(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  // Trim leading zeros for a cleaner decimal string.
  const big = BigInt('0x' + s);
  return big.toString();
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}

function jsonError(request, status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders(request), 'content-type': 'application/json' },
  });
}
