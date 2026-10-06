# mcp-erp-server

[![CI](https://github.com/mateusmeloc/mcp-erp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/mateusmeloc/mcp-erp-server/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)

A reference [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI assistant
(Claude, ChatGPT, Claude Code, any MCP client) work with a small business's ERP **safely**: customers,
appointments, invoices and bills.

It runs against an in-memory **mock ERP with synthetic data**, so you can clone it and try it in a minute.
The interesting part is not the mock, it is everything around it: how to expose real business data and
write operations to a language model without handing it the keys.

> This is a cleaned-up, generic version of patterns I use in production MCP servers for a dental clinic
> (appointments, receivables, payables). No real data, names or credentials are in this repository.

## What it demonstrates

| Concern | How it is handled | Where |
|---|---|---|
| **Remote MCP transport** | Stateless Streamable HTTP: a fresh `McpServer` + transport per request, nothing kept between calls, so it scales horizontally and survives restarts | `src/app.ts` |
| **Authentication** | OAuth 2.1 for MCP clients: protected-resource and authorization-server metadata (RFC 9728 / RFC 8414), dynamic client registration (RFC 7591), authorization code + **PKCE S256**, refresh tokens. Static per-person bearer tokens also work for scripts and Claude Code | `src/auth/` |
| **Authorization** | Role-scoped tool registration: the role decides which tools **exist** for that caller. A tool that was never registered cannot be called by mistake, or by a model that was talked into it | `src/auth/roles.ts`, `src/mcp/server.ts` |
| **Safe writes** | Every write is two steps: a **preview** that changes nothing, then execution with a confirmation token that is bound to the tool, the person and a hash of the exact arguments, expires, and works once | `src/mcp/confirm.ts`, `src/mcp/writes.ts` |
| **Blast-radius controls** | Global kill switch (`ALLOW_WRITES=false`), per-person per-family write rate limit, delete tools kept in their own family that most roles never get | `src/mcp/writes.ts` |
| **Data minimization** | Search results and profiles return masked personal data; full contact details live behind a separate tool that only some roles can reach and that is audited | `src/erp/privacy.ts` |
| **Audit trail** | Every preview, execution, denial and sensitive read is logged as structured JSON with ids and amounts, never personal data. The logger also redacts anything that looks like a credential | `src/mcp/audit.ts`, `src/logger.ts` |
| **Testing** | 40 tests: unit, tool-level through a real MCP client, and end-to-end over HTTP including the full OAuth flow | `test/` |

## Quick start

```bash
git clone https://github.com/mateusmeloc/mcp-erp-server.git
cd mcp-erp-server
npm install
cp .env.example .env     # demo values only; see "Configuration"
set -a; . ./.env; set +a
npm run dev              # http://localhost:3000
```

Check it is alive and that it asks for credentials:

```bash
curl -s localhost:3000/healthz
curl -si -X POST localhost:3000/mcp | head -n 3     # 401 + WWW-Authenticate
```

Then talk to it with the demo admin key from `.env.example`:

```bash
curl -s localhost:3000/mcp \
  -H "Authorization: Bearer change-me-demo-admin-token-0001" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Or point the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at `http://localhost:3000/mcp`.

```bash
npm test          # 40 tests, no network needed
npm run typecheck
npm run build && npm start
```

## Tools

| Tool | Family | Read / write | What it does |
|---|---|---|---|
| `erp_status` | system | read | Who you are connected as, your role, and whether write tools are enabled |
| `customer_search` | customers | read | Find customers by name, id or city. Returns who they are, never contact details |
| `customer_get` | customers | read | A profile with email, phone and document **masked** |
| `customer_get_contact` | customers-pii | read, audited | Full contact details of one customer; every call is logged with the caller's stated reason |
| `appointments_list` | scheduling | read | Appointments in a date range (max 62 days), filterable by staff and status |
| `appointments_availability` | scheduling | read | Free start times for one staff member on one day (30-minute grid, working hours) |
| `appointment_book` | scheduling-write | **write** (preview + confirm) | Books a slot |
| `appointment_cancel` | scheduling-write | **write** (preview + confirm) | Cancels an appointment |
| `invoices_list` | finance | read | Invoices by status, customer and due-date range |
| `receivables_summary` | finance | read | Open invoices aged: not yet due, 1-30, 31-60, 61+ days overdue |
| `cashflow_forecast` | finance | read | Expected money in and out in weekly buckets; overdue amounts reported separately |
| `payables_list` | finance | read | Bills to pay, sorted by due date |
| `invoice_mark_paid` | finance-write | **write** (preview + confirm) | Registers a payment |
| `payable_create` | finance-write | **write** (preview + confirm) | Creates a bill |
| `payable_delete` | finance-delete | **write** (preview + confirm) | Permanently deletes an open bill. Its own family on purpose |

### Roles

| Role | Gets | Typical use |
|---|---|---|
| `admin` | Every family, including ones added in the future | The owner |
| `manager` | Everything except `finance-delete` | Runs the day to day, including money |
| `frontdesk` | System, customers (masked), scheduling and its writes. No money | Reception |
| `agent` | Scheduling and its writes only | An automated assistant that talks to strangers (a chat bot) |

`admin` is the only open-ended role. The others are closed lists, so a family added tomorrow is
invisible to them until someone grants it deliberately.

## How a write works

```text
 model ──► appointment_book(customer_id, staff, start)  ──► PREVIEW: "Book a <service> for Alex Rivera
                                                           (C-001) with <staff> on <start>, 30 minutes."
                                                           + confirmation_token   (nothing changed)
 human sees the preview and approves
 model ──► appointment_book(same args, confirm=true,
                            confirmation_token=…)      ──► executed (token consumed, audited)
```

The token is HMAC-signed and carries a hash of `tool | person | canonical(args)`, an expiry and a
unique id. So the model cannot skip the preview, cannot run something different from what the
human saw (any changed argument invalidates it), cannot use someone else's token, and cannot replay
an old approval. State is revalidated at execution time, because the calendar may have changed
between preview and confirm.

The order inside `runWrite` is fixed, in one place, so the guardrails cannot drift apart between
tools: kill switch, rate limit, revalidate, preview or consume token, run, audit.

## Connecting a client

The server exposes one endpoint, `POST /mcp`, plus the OAuth endpoints. Deploy it behind HTTPS
(OAuth redirects and bearer tokens must never travel in clear text) and set `PUBLIC_URL` to the
public address.

- **Claude / ChatGPT (custom connector):** add `https://your-host/mcp` as a remote MCP server. The
  client discovers the OAuth metadata, registers itself, and sends the person to the consent page,
  which asks for **their own access key** (the token from `ERP_USERS`). The consent page names the
  client and the host it will redirect to.
- **Claude Code:** `claude mcp add --transport http erp https://your-host/mcp --header "Authorization: Bearer <access key>"`
- **Scripts:** send `Authorization: Bearer <access key>` directly.

## Configuration

Everything comes from environment variables and is validated at boot; a bad configuration stops the
process with a clear message instead of running half-configured. See [`.env.example`](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `TOKEN_SECRET` | required | At least 32 chars. Signs OAuth tokens and confirmation tokens |
| `ERP_USERS` | required | JSON array: `[{"name":"alice","role":"admin","token":"…"}]`. One token per person (at least 24 chars) so revoking one does not affect the others |
| `PORT` | `3000` | |
| `PUBLIC_URL` | request host | Public base URL used in the OAuth metadata |
| `ALLOW_WRITES` | `true` | Global kill switch for every write tool |
| `TRUST_PROXY` | `false` | Set to `1` behind a reverse proxy so rate limits see the real client IP |
| `WRITES_PER_MINUTE` | `10` | Per person, per write family |
| `CONFIRM_TTL_SECONDS` | `300` | How long a preview stays confirmable |
| `ACCESS_TTL_SECONDS` | `3600` | OAuth access token lifetime |
| `REFRESH_TTL_SECONDS` | `2592000` | OAuth refresh token lifetime (30 days) |

With `NODE_ENV=production` the server **refuses to start** if any credential contains the demo
marker `change-me`.

**Revoking access:** remove the person from `ERP_USERS` and restart. Roles are read from the current
configuration on every request, not from the token, so the change takes effect immediately for
OAuth tokens too. Rotating `TOKEN_SECRET` revokes every issued token at once.

## Project layout

```text
src/
  app.ts            Express app: /mcp (stateless), /healthz, error handling
  config.ts         Env parsing and validation (fails loudly at boot)
  auth/             roles, signed tokens, identity, OAuth 2.1 server + consent page
  erp/              the mock ERP (types, store with deterministic seed data, privacy masking)
  mcp/              server factory, write pipeline, confirmations, audit
    tools/          one file per family
test/               unit, tool-level (real MCP client) and HTTP/OAuth end-to-end tests
```

To use it with a real system, replace `src/erp/store.ts` with a client for your ERP and keep the
tool layer, roles and write pipeline as they are.

## Limits you should know about

This is a reference implementation, not a turnkey product. Honest list:

- **Single instance.** Rate limiters, OAuth authorization codes, registered clients and the
  single-use ledger of confirmation tokens live in memory. Behind several replicas, or across
  restarts, they are not shared (a restart invalidates pending previews and codes, which fails
  safe). Move them to Redis or a database before scaling out.
- **Refresh tokens are not one-time.** A new pair is issued on every refresh, but the server is
  stateless, so the previous refresh token stays valid until it expires. Strict rotation needs a
  store.
- **Dynamic client registration is open**, as DCR is by design, so it is treated as untrusted:
  redirect URIs must be `https` or loopback and are matched exactly, codes are single use and bound
  to client + redirect URI + PKCE, and nothing is granted without a valid access key. If you need
  stricter control, add an allow-list of clients.
- **Access keys are shared secrets**, not an identity provider. For a team, put this behind your SSO
  or replace `auth/identity.ts`.
- **The data is fake.** Money is USD, times are UTC, the business is a generic service shop.

## License

[MIT](LICENSE)
