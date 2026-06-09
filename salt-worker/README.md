# OPTIC Salt Service

A tiny Cloudflare Worker that issues deterministic per-user salts for
[zkLogin](https://docs.sui.io/concepts/cryptography/zklogin).

## Why a server?

A zkLogin salt is a per-(or per-group) random value that binds a Google
OAuth subject to a Sui address. Salts must be:

- **Secret** — anyone with the salt can re-derive the user's address.
- **Deterministic per user** — so a returning user gets the same address.

Both properties require server-side state. A pure static Walrus Site
can't keep a secret, so we deploy this Worker alongside it.

The salt is derived as `HMAC-SHA256(SALT_SECRET, jwt)`. The JWT is only
kept in memory for the duration of the request; nothing is logged or
persisted.

## Deploy

```bash
# 1. Install wrangler (if you don't have it):
pnpm dlx wrangler --version

# 2. Authenticate:
pnpm dlx wrangler login

# 3. Set the secret. Pick 32+ random characters:
pnpm dlx wrangler secret put SALT_SECRET
# (paste the value when prompted)

# 4. Deploy:
pnpm dlx wrangler deploy

# 5. The URL will be printed, e.g.
#    https://optic-salt.<your-subdomain>.workers.dev
#    Set that as your saltUrl in chrome.js (or window.OPTIC_CONFIG).
```

## Endpoint

```http
POST /salt
Content-Type: application/json

{ "jwt": "eyJhbGciOi..." }
```

Returns:

```json
{ "salt": "12345678901234567890" }
```

Validates that the JWT is a Google id_token (`iss` ends with
`accounts.google.com`). Any other issuer is rejected with HTTP 400.

CORS is enabled for all origins, but the Worker will only respond to
Google-issued JWTs, so a leaked URL is harmless without the `SALT_SECRET`.

## Local dev

```bash
pnpm dlx wrangler dev
# → http://127.0.0.1:8787/salt
```

For local dev, set the secret in a `.dev.vars` file (gitignored):

```
SALT_SECRET=any-32-char-string-here
```
