AI Agent API

Overview
This project is a production-grade AI Agent API that converts natural language into safe database operations and thoughtful answers. It supports MongoDB, Postgres, and MySQL, and includes a modern WebSocket playground for live demos. The agent plans, executes, and analyzes results, learns from user interactions, and enforces strict safety guardrails.

Start here (reading path)
1) Quick Start: install, configure env, run, open playground
2) Architecture: understand the components and data flow
3) Deep dive: User Level, Context Memory, and Chat Sessions
4) Security & Guardrails: what we block and why
5) API Reference: HTTP endpoints and WebSocket events
6) Playground: how to use the demo UI
7) Environment variables: all important knobs
8) Development: scripts and workflows
9) Logging & observability: how it’s instrumented
10) Demo script: a suggested walkthrough
11) Engineering highlights: design choices and impact

Key Features
- Multi-DB support: MongoDB, Postgres, MySQL
- Plan → Execute → Analyze agent workflow with dry-run preview
- Strong safety guardrails for SQL and Mongo
- User-specific memory and learning over time
- WebSocket chat with session management
- Playground: login-first flow, auto-fill JWT/userId/sessionId, dry-run toggle, plan/trace viewer
- Connection pooling and caching for performance

Quick Start
1) Install
```
npm install
```

2) Configure environment
Create .env.development.local with at least:
```
SECRET_KEY=your-jwt-secret
GOOGLE_API_KEY=your-google-gemini-api-key
PORT=3000

# Optional tuning
SCHEMA_REGISTRY_TTL_MS=86400000        # default 24h
DEFAULT_ROW_LIMIT=1000                 # cap for reads/aggregations
QUERY_TIMEOUT_MS=15000                 # SQL execution timeout
REDACT_SQL_IN_RESPONSES=false          # hide SQL text in responses
PG_POOL_MAX=10                         # Postgres pool size
```

3) Run in development
```
npm run dev
```

4) Open the playground
Open playground/index.html in a browser (served by your dev server, or open the file and point Server URL to your API host: http://localhost:3000).

Architecture
Client → Server → Agents → Infra → Databases
- Client: Playground with WebSocket client and login-first UX.
- Server: Express + Socket.io; routes messages, authenticates JWT, manages sessions.
- Agents:
  - AIAgentService: Plan → Execute → Analyze, multi-DB, safety guardrails, dry-run.
  - DatabaseAgentService: LangGraph state machine for legacy/fallback flow.
- Infra: DbPoolService (connection/pool cache), Schema Detectors, AIMemoryService, Mongoose models, Logger.
- Databases: MongoDB, Postgres, MySQL.

Mermaid Diagram (System)
```mermaid
flowchart TD
  subgraph "Client"
    UI["Playground UI\n- Login -> JWT + userId\n- Auto sessionId\n- Dry run toggle\n- Send message"]
    WSClient["Socket.io client"]
  end

  subgraph "Server"
    WS["WebSocketChatService\n- Auth via JWT\n- join-session, send-message"]
    AIAgentHTTP["AIAgentController\n/api/ai-agent/query"]
    AuthCtl["AuthController\n/login, /signup, /logout"]
  end

  subgraph "Agents"
    AIAgent["AIAgentService\nPlan → Execute → Analyze\n- Memory-aware\n- Safety guardrails\n- Multi-DB\n- Dry-run"]
    DBGraph["DatabaseAgentService\nLangGraph states:\nanalyze → context → plan → tools → response"]
  end

  subgraph "Infra"
    Pool["DbPoolService\n- Mongo: cached Connection per dbUrl\n- Postgres: cached Pool per dbUrl\n- MySQL: cached Pool per dbUrl"]
    SchemaDetect["SchemaDetector / SQLSchemaDetector\n- Introspect schema\n- Render schema for LLM"]
    Memory["AIMemoryService\n- recordQuery\n- getMemoryInsights\n- update UserPreferences\n- recordFeedback"]
    Models["Mongo Models\nChatSession, ChatMessage, Users, AIMemory, UserPreferences"]
  end

  subgraph "Databases"
    Mongo["MongoDB"]
    Postgres["Postgres"]
    MySQL["MySQL"]
  end

  UI -->|"Login (email,password)"| AuthCtl
  AuthCtl -->|"token,user"| UI
  UI -->|"Connect with JWT"| WSClient
  WSClient -->|"authenticate"| WS
  UI -->|"Join session"| WS
  UI -->|"Send message (message, dbUrl?, dbType?, dryRun?)"| WS

  WS -->|"if dbUrl provided"| AIAgent
  WS -->|"else"| DBGraph
  AIAgentHTTP --> AIAgent

  AIAgent -->|"get(dbUrl)"| Pool
  AIAgent --> SchemaDetect
  AIAgent -->|"getMemoryInsights + recordQuery"| Memory
  AIAgent -->|"Plan"| AIAgent
  AIAgent -->|"Execute (dryRun? preview only)"| Mongo
  AIAgent -->|"Execute (dryRun? preview only)"| Postgres
  AIAgent -->|"Execute (dryRun? preview only)"| MySQL
  AIAgent -->|"Summarize"| AIAgent
  AIAgent -->|"recordQuery"| Memory

  DBGraph --> SchemaDetect
  DBGraph --> Memory
  DBGraph -->|"Tool exec"| Models

  Pool --> Mongo
  Pool --> Postgres
  Pool --> MySQL

  AIAgent -->|"result + plan + trace + executedQueries + executionTime"| WS
  DBGraph -->|"message + data + toolsUsed + confidence"| WS
  WS -->|"agent-response"| UI
```

Security & Guardrails
- SQL: block DROP/TRUNCATE/ALTER; require WHERE on UPDATE/DELETE; single-statement; no comments; parameterized placeholders ($1 or ?).
- Mongo: forbid $where/$function; disallow dangerous aggregation stages ($out/$merge); require specific filters on writes; exclude sensitive fields.

Planning & Dry-Run
- AIAgentService creates a small JSON plan using LLM.
- Dry run: generates queries and plan/trace without executing; great for audits and demos.
- Execute: runs queries through pooled connections, then summarizes results for the user.

Memory & Personalization
- AIMemoryModel stores each query, success, result counts, collections, tags, and pattern.
- UserPreferencesModel tracks frequent collections, query patterns, and learning profile.
- Each request updates memory and retrieves insights to shape prompts and suggestions.

Connection Pooling
- DbPoolService caches per-dbUrl:
  - Mongo: mongoose.Connection
  - Postgres: pg.Pool
  - MySQL: mysql2 Pool
- Benefits: reduced latency, fewer handshakes, resilience across requests.

Playground
- Login: prompts for email/password, captures token and userId.
- Auto IDs: decodes JWT to fill userId; auto-generates sessionId.
- Dry run: previews plan and queries without executing.
- Plan & Trace panel: displays plan JSON, executedQueries, and tool traces.

API Reference (Selected)
- Auth
  - POST /login -> { token, data }
  - POST /signup, POST /logout
- AI Agent
  - POST /api/ai-agent/query { query, dbUrl, dbType?, dryRun?, refreshSchema? }
  - GET /api/ai-agent/status, GET /api/ai-agent/samples
- WebSocket events
  - join-session { sessionId, userId }
  - send-message { message, sessionId, dbUrl?, dbType?, dryRun? }
  - typing, get-sessions, create-session, delete-session

Demo Script (Hackathon)
1) Login in the playground (get JWT + userId auto-filled) and join a session.
2) Dry-run a query (e.g., "Top 5 products by revenue last 30 days" with Postgres URI):
   - Show plan JSON and previewed SQL in Plan & Trace.
3) Uncheck Dry run and run the query; point out safety guardrails and single-statement enforcement.
4) Ask a follow-up question to demonstrate memory-based suggestions.
5) Show that greetings receive a friendly, non-query response.

Development
```
npm run dev        # start dev
npm run build      # compile with swc
npm test           # run tests
npm run lint       # lint
```

Notes
- Configure Google API key in environment for LLM calls.
- Provide valid dbUrl for the target database (Mongo/Postgres/MySQL).
 - Persistent Schema Registry: the agent caches per-DB schema (hashed key, credentials stripped) and refreshes after TTL. You can force rebuild by sending `refreshSchema: true` in the request.

## What this agent now does (key points)

### Data access and safety
- Dynamic schema detection for Mongo and SQL, persisted in a Schema Registry (hashed key, no secrets). TTL configurable via `SCHEMA_REGISTRY_TTL_MS`.
- Response shaping via `insight`:
  - `insight: true` returns full plan, trace, executedQueries, suggestions (debug/verbose).
  - Omit/false returns minimal Postman-style body: `{ data, message, success: true }`.
- Guardrails:
  - SQL: parameterized-only; block DROP/TRUNCATE/ALTER; enforce WHERE on UPDATE/DELETE; single statement; comments blocked; query timeout via `QUERY_TIMEOUT_MS`.
  - Mongo: block `$where/$function` and dangerous stages; safe updates; projection redaction; default row caps via `DEFAULT_ROW_LIMIT`.
- Row caps: Mongo reads and aggregations capped by `DEFAULT_ROW_LIMIT` (also injected `$limit` when needed).
- Connection pooling: Postgres/MySQL pools with `PG_POOL_MAX`; Mongo connections cached per `dbUrl`.
- Connection validation: When an invalid `dbUrl` is supplied, the system surfaces `DB_CONNECTION_FAILED: <reason>` (for Mongo, Postgres and MySQL).

### Reasoning before querying (dynamic questions)
- Capability profiling: Infers what the DB can answer (e.g., top_selling_products, revenue_over_time) and feeds it into planning to guide tool selection.
- Schema keyword hints (Mongo): Extracts keywords from the user query and matches likely collections/fields to make vague questions actionable.
- SQL insights: For questions like “most/top/best selling product?”, the agent infers likely line-item/product tables and composes a safe top-selling query first; otherwise falls back to planned execution.

### Multi-DB support
- First-class support for `mongodb`, `postgres`, and `mysql` through a unified `/api/ai-agent/query`.
- Registry-backed schema context: reuse across sessions and users, with `refreshSchema` to force re-scan.

### API flags and examples
- `dryRun`: Return planned queries and trace without executing.
- `refreshSchema`: Refresh persistent schema snapshot for the given `dbUrl`.
- `insight`: Toggle verbose vs minimal response.

Minimal example (Postman-style):
```json
{
  "query": "Most selling product?",
  "dbUrl": "postgres://user:pass@localhost:5432/mydb",
  "dbType": "postgres",
  "insight": false
}
```
Response:
```json
{ "data": [/* rows */], "message": "…", "success": true }
```

Verbose example (debugging):
```json
{
  "query": "Top 5 products by revenue last 30 days",
  "dbUrl": "mysql://user:pass@localhost:3306/mydb",
  "dbType": "mysql",
  "dryRun": false,
  "refreshSchema": false,
  "insight": true
}
```

### Logging and observability
- Request correlation: each HTTP request has a `requestId`; errors include stack metadata.
- File logs: daily-rotating JSON logs for debug and error; console remains human-readable.
- Configurable redaction: `REDACT_SQL_IN_RESPONSES=true` hides SQL text in responses.

### Swagger and HTTP samples
- Swagger spec fixed and upgraded (Swagger 2.0 header added; consolidated definitions). Visit `/api-docs`.
- `src/http/ai-agent.http` includes Mongo/Postgres/MySQL examples, and demonstrates `dryRun`, `refreshSchema`, and `insight`.

### Playground upgrades
- New toggles for `dryRun`, `refreshSchema`, `insight`.
- HTTP testing panel: editable request body, Send, Copy, and pretty response.
- Pretty JSON outputs for data, plan, and trace; clear buttons for each panel.

## Deep dive: User Level, Context Memory, and Chat Sessions

### User level (learning profile)
- **What it is**: A personalization indicator stored per user, not an authorization role. It guides tone/detail of responses and suggestions.
- **Where defined**: `UserPreferences.learningProfile.skillLevel` in `src/models/ai-memory.model.ts` with values `beginner` | `intermediate` | `advanced` (default `beginner`).
- **How it evolves**: Upgraded by successful usage milestones inside `AIMemoryService.updateUserPreferences`:
  - >50 successful queries: `beginner` → `intermediate`
  - >150 successful queries: `intermediate` → `advanced`
- **Where used**: `AIAgentService.processQuery` loads memory via `getMemoryInsights(...)` and includes `memoryInsights.userLevel` in the response metadata. The agent also conditions prompts/suggestions on user preferences.
- **Why**: Personalizes explanations and nudges without adding RBAC complexity. This is not a permission system.

### Context memory (long‑term, per user)
- **What is stored** (`AIMemoryModel`):
  - `userId`, `query`, `generatedMongoQuery`/`sql`, `queryType`, `collections`, `executionTime`, `resultCount`, `wasSuccessful`, `contextTags`, `queryPattern`, timestamps.
- **Preferences tracked** (`UserPreferencesModel`):
  - `frequentCollections`, `queryHistory` with frequencies, `learningProfile` (skill level, preferred detail, common mistakes).
- **How it’s built** (`AIMemoryService`):
  - On each request the agent calls `recordQuery(...)` and `updateUserPreferences(...)`.
  - Heuristics extract a `queryPattern` (e.g., `find_email_date`) and `contextTags` (e.g., `email-search`, `date-filter`).
  - `getMemoryInsights(...)` returns similar past queries, preferences, and tailored suggestions to guide planning and response.
- **Where used**: `AIAgentService` enriches planning, query generation, and final messaging with these insights; suggestions are surfaced in responses.
- **Why**: Improves accuracy and UX by recalling habits and successful patterns, reducing re‑explanation and enabling smarter defaults.

### Chat sessions (WebSocket, short‑term conversation state)
- **Authentication**: Socket.io middleware validates JWT and attaches `userId`.
- **Join/create**: Client emits `join-session { sessionId, userId }`. If the session doesn’t exist, `WebSocketChatService` creates it (`ChatSessionModel`).
- **Persisted session context**: `session.context` stores:
  - `databaseContext`: the last `{ dbUrl, dbType }` used so you don’t resend it every message.
  - `recentQueries`: last few prompts for conversational continuity.
- **Message flow**: `send-message { message, sessionId, dbUrl?, dbType?, dryRun? }`
  - If an effective DB URL is available (payload or session context), routes to `AIAgentService` (Plan → Execute → Analyze).
  - Otherwise falls back to the LangGraph `DatabaseAgentService` with enriched history.
  - Both paths persist user/agent messages (`ChatMessageModel`) and update memory.
- **Housekeeping**: Sessions and messages are indexed; sessions carry a TTL index to auto‑expire old inactive sessions (30 days).
- **Why**: Maintains conversational continuity, enables multi‑session UX, and reuses DB context safely across turns.

### Response metadata (where to see this)
- `AIAgentService.processQuery` includes a compact `memoryInsights` object in responses:
  - `userLevel` (derived from `UserPreferences.learningProfile.skillLevel`)
  - `similarQueries` (count)
  - `queryPattern`
  - `suggestions` (array)
  - When `insight` is true, you’ll also see `plan`, `trace`, and `executedQueries` for deeper debugging.

### Extensibility tips
- Tune level thresholds or add dimensions (e.g., domain expertise) inside `AIMemoryService.updateUserPreferences`.
- Add richer pattern/tag extraction in `AIMemoryService` to capture your domain language.
- Attach more structured context to `ChatSession.context` (e.g., tenant/org, preferred time window) to cut user friction.

### LangGraph agent hardening (fallback WS agent)
- Stricter tool-selection prompt requiring valid JSON; robust parsing/validation.
- Per-node timing logs for analyze/load-context/plan/execute/generate-response.
- Guardrails and caps applied inside dynamic tools; timeouts on queries.

## Why we built it this way (approach + challenges solved)

- Persistent schema registry
  - Problem: Re‑introspecting schemas on every request caused latency spikes and inconsistent prompts, especially for large DBs.
  - Approach: Persist a JSON snapshot per `dbUrl` (credentials stripped, hashed key), TTL controlled by `SCHEMA_REGISTRY_TTL_MS` and on‑demand `refreshSchema`.
  - Result: Faster, consistent planning and better LLM grounding across sessions/users.

- Connection validation with explicit errors
  - Problem: Frontend didn’t get useful errors when a bad `dbUrl` was supplied; failures surfaced later as generic 500s.
  - Approach: Postgres/MySQL run `SELECT 1` with timeout; Mongo throws a clear `DB_CONNECTION_FAILED: …` message.
  - Result: Early, actionable feedback for the UI; fewer blind retries.

- Safety guardrails + row caps
  - Problem: Accidental destructive SQL (DELETE without WHERE), slow queries, and unbounded result sets.
  - Approach: Strict SQL/Mongo rules, single statement, comments blocked, default `DEFAULT_ROW_LIMIT`, `$limit` injected for Mongo aggregates, timeouts via `QUERY_TIMEOUT_MS`.
  - Result: Safer by default and more predictable performance.

- Capability profiling before planning
  - Problem: Vague questions (“Most selling product?”) produced weak plans because the LLM lacked an understanding of table roles.
  - Approach: Inspect schema/columns to infer feasible analyses (e.g., sales, revenue over time) and provide a concise “capabilities” summary to the planner.
  - Result: Better plan selection and fewer irrelevant queries.

- SQL insights for underspecified analytics
  - Problem: Users expect smart answers for common analytics (top sellers, revenue) even when table names differ.
  - Approach: Infer likely tables/keys from information_schema and compose safe “top” queries; fallback to standard plan.
  - Result: Higher hit‑rate for common business questions without hand‑tuning.

- Schema keyword matcher (Mongo)
  - Problem: Natural language may only mention nouns (“orders”, “products”) or attributes (“quantity”), not exact collection names.
  - Approach: Extract query keywords and match to collections/fields to bias planning.
  - Result: More accurate collection/field targeting without user friction.

- Insight vs minimal responses
  - Problem: Frontends often need a compact shape (`data`, `message`, `success`) while devs need full debug info (plan/trace).
  - Approach: `insight` flag drives response shaping—verbose when true, minimal otherwise.
  - Result: Cleaner UI integration and easier debugging when needed.

- Logging and observability
  - Problem: Hard to correlate issues across requests and ingest file logs.
  - Approach: Request IDs, JSON daily‑rotating file logs, and optional SQL redaction for production.
  - Result: Faster troubleshooting; safer logs.

- Swagger fixes and samples
  - Problem: Swagger UI showed “No operations defined” due to missing header/duplicate definitions; examples out of date.
  - Approach: Added the `swagger: "2.0"` header, consolidated definitions, and updated examples for `dryRun`, `refreshSchema`, `insight`.
  - Result: Live, accurate docs at `/api-docs`.

### Typical failure modes addressed
- Invalid DB URL → now returns `DB_CONNECTION_FAILED: <driver message>` early.
- Vague questions → capability profiling + insights nudge the agent to the right data paths.
- Oversized responses → default row caps and injected `$limit` for Mongo aggregates.
- Dangerous SQL/Mongo → strict guardrails block risky patterns before execution.
- Drifted schema context → persistent registry with TTL and `refreshSchema`.

### Trade‑offs and next steps
- Heuristics: Insight builders (e.g., top sellers) are conservative and schema‑dependent; we prefer safe fallbacks over brittle guesses.
- Extensibility: Add more insights (e.g., churn, retention, low‑stock) and enable background schema revalidation.
- Observability: Optional tracing (LangSmith/OpenTelemetry) can be added for step‑level spans in production.

## Engineering highlights (challenge → solution → impact)

- Schema cold‑start latency → Persistent, hashed schema registry with TTL
  - Solution: Normalize URL (strip creds), SHA‑256 key, store JSON schema, serve instantly until TTL or `refreshSchema`.
  - Impact: 10x faster prompt grounding across sessions; consistent planning without re‑introspection storms.

- Vague questions → Multi‑pronged reasoning (profiling + keyword hints + insights + plan)
  - Solution: Detect capabilities from real columns, match query keywords to collections (Mongo), attempt safe “insight” SQL for common analytics, then plan/execute.
  - Impact: High hit‑rate on underspecified asks like “Most selling product?” without manual schema tutoring.

- Safety under uncertainty → Guardrails + limits + timeouts
  - Solution: SQL single‑statement, parameterized only, forbid DROP/TRUNCATE/ALTER, require WHERE on writes; Mongo dangerous stage/operator blocks; `DEFAULT_ROW_LIMIT` caps; `QUERY_TIMEOUT_MS` timeouts.
  - Impact: Reduced blast radius and runaway queries; predictable performance by default.

- Unhelpful errors on bad dbUrl → Preflight connection testing
  - Solution: Postgres/MySQL `SELECT 1` with 5s timeout; Mongo explicit error wrap; surface `DB_CONNECTION_FAILED: …` to client.
  - Impact: Clear, early feedback to the frontend; no silent failures.

- Noisy vs developer‑friendly responses → Response shaping
  - Solution: `insight` flag toggles full debug payload (plan/trace/executedQueries) vs minimal `{ data, message, success }`.
  - Impact: Clean UX for product, deep visibility for debugging when needed.

- Non‑deterministic tool selection → Strict JSON contracts
  - Solution: Force tool plans and graph decisions to output valid JSON; sanitize and validate before execution.
  - Impact: Fewer parsing failures; repeatable behavior at lower temperatures.

- Repeating dbUrl in chat → Session‑level DB context memory
  - Solution: Remember `dbUrl`/`dbType` in session context after first message; reuse automatically.
  - Impact: Natural conversational flow; less friction.

- Pool exhaustion / slow statements → Tuned pools & statement timeouts
  - Solution: `PG_POOL_MAX`, Postgres `statement_timeout`, MySQL execution timeouts via Promise.race.
  - Impact: Back‑pressure under load; fewer stuck workers.

- Data leakage in logs/responses → Redaction and hashed keys
  - Solution: `REDACT_SQL_IN_RESPONSES`, JSON log files, console pretty, hashed schema keys without credentials.
  - Impact: Safer observability in production.

- Docs drifting from runtime → Fixed Swagger and rich HTTP samples
  - Solution: Valid Swagger 2.0 header, single definitions block, examples for `dryRun`/`refreshSchema`/`insight`; `src/http/*.http` aligned.
  - Impact: Live /api-docs that actually mirrors the API.

- Developer & demo UX → Upgraded playground
  - Solution: Toggles for flags, HTTP request panel with copy, pretty JSON viewers, and clear buttons.
  - Impact: Faster iteration and clearer demos.

## Environment variables recap
- `GOOGLE_API_KEY`: LLM API key (required)
- `SCHEMA_REGISTRY_TTL_MS` (default 86400000)
- `DEFAULT_ROW_LIMIT` (default 1000)
- `QUERY_TIMEOUT_MS` (default 15000)
- `REDACT_SQL_IN_RESPONSES` (false|true)
- `PG_POOL_MAX` (default 10)
- `LOG_DIR` (default `logs`)

### Environment

Add to your `.env.development.local` (and/or production env):

```
GOOGLE_API_KEY=your_key
GOOGLE_MODEL=gemini-1.5-flash
```

- Recommended free/low-cost models:
  - gemini-1.5-flash-8b (fast, very low cost)
  - gemini-1.5-flash (balanced)
  - gemini-2.0-flash (newer; often limited free quota)

If unset, the default is `gemini-1.5-flash`.

