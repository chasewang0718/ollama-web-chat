# Cydonia Web Client

A local-first AI chat app built with Next.js + Ollama, with dual-backend conversation storage (cloud/local), conversation migration, and long-term memory retrieval.

## Core Features

- Chat with any model from your local Ollama runtime (model list loaded dynamically).
- Switch models inside the same conversation; only subsequent turns use the newly selected model.
- User message editing ("re-input" flow): edit an earlier user bubble, then `取消` or `更新` to regenerate from that turn.
- Message actions with compact icon controls:
  - User side: `编辑` + `复制`
  - Assistant side: `重做` + `复制`

## Dual Storage Architecture

- Supports `cloud`, `local`, and `hybrid` storage modes.
- New conversation creation supports backend choice at creation time:
  - `新对话 · 云端`
  - `新对话 · 本地`
- Each conversation shows storage origin in sidebar (`cloud`/`local` icon).
- Right-click conversation context menu supports single-conversation migration:
  - `迁移到云端`
  - `迁移到本地`

## Storage Reliability / Auto-Recovery

- Before conversation/chat/migration operations, backend readiness is checked.
- For local backend, app attempts auto-start flow (`supabase start`) when unreachable.
- Clear error responses are returned if backend still unavailable (for example Docker Engine not running).
- Migration API now validates both source and target backend readiness before data copy.

## Memory System (Model-Agnostic)

Memory is shared across all models used by the app (not tied to any single model):

- L1: current chat context window
- L2: rolling conversation summary
- L3: vector memory retrieval from database (`memories`)

Current memory behavior:

- Semantic merge + versioned memory records (`memory_versions`).
- Importance scoring + decay + compacting duplicate versions.
- Near-infinite retention strategy by default:
  - `MEMORY_HARD_MAX_ITEMS=0` disables hard-count pruning.
  - `MEMORY_CLEANUP_STALE=false` disables stale low-importance deletion.

## Local / Cloud Setup

### Cloud

Required:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MEMORY_USER_ID`

### Local Supabase

Required:

- `LOCAL_SUPABASE_URL` (default: `http://127.0.0.1:54321`)
- `LOCAL_SUPABASE_SERVICE_ROLE_KEY`
- Docker Desktop / Docker Engine available

Recommended:

- Enable Docker Desktop auto-start on system startup for smoother local backend auto-recovery.

## Environment Variables (Important)

- `STORAGE_MODE=cloud|local|hybrid`
- `STORAGE_HYBRID_WRITE_BACKEND=cloud|local`
- `MEMORY_ENABLED=true|false`
- `MEMORY_MATCH_COUNT`
- `MEMORY_MIN_SIMILARITY`
- `MEMORY_HEALTHCHECK_INTERVAL`
- `MEMORY_HARD_MAX_ITEMS`
- `MEMORY_CLEANUP_STALE`

See `.env.example` for full list and defaults.

## Run

```bash
npm install
npm run dev
```

Open: [http://localhost:3000](http://localhost:3000)
