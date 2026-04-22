# 🚗 Trade Way CRM

نظام إدارة علاقات العملاء (CRM) لشركة Trade Way / Captain Masr — مخصص لإدارة تسجيل السواقين في شركات النقل (أوبر، إن درايف) عبر دول متعددة.

---

## 🏗️ Architecture

```
crm-tradeway/
├── apps/
│   ├── api/              # Backend (Fastify + TypeScript + Prisma)
│   └── web/              # Frontend (React + TypeScript)  [Phase 2]
├── packages/
│   └── shared/           # Shared types
├── docker-compose.yml    # PostgreSQL + Redis
└── package.json          # pnpm workspaces
```

### Tech Stack

- **Backend:** Node.js 20+ · TypeScript · Fastify · Prisma ORM · PostgreSQL · Redis · BullMQ
- **Auth:** JWT (access + refresh with rotation)
- **Validation:** Zod
- **Package Manager:** pnpm (workspaces)

---

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+ (`npm install -g pnpm`)
- Docker + Docker Compose

### Setup

```bash
# 1. Install dependencies (from root)
pnpm install

# 2. Start PostgreSQL + Redis
docker compose up -d

# 3. Set up environment
cd apps/api
cp .env.example .env
# (the .env file is already configured for local dev)

# 4. Run migrations + seed data
pnpm db:migrate   # creates tables
pnpm db:seed      # populates sample data

# 5. Start the API
cd ../..
pnpm dev:api
```

The API will be running at **http://localhost:3000**

---

## 🔐 Test Accounts

All accounts use password: `Password@123`

| Role | Email |
|------|-------|
| 🔐 Super Admin | `super@tradeway.com` |
| 🔐 Operations Manager | `ops@tradeway.com` |
| 🇪🇬 Egypt Account Manager | `eg.manager@tradeway.com` |
| 🇸🇦 Saudi Account Manager | `sa.manager@tradeway.com` |
| 🇲🇦 Morocco Account Manager | `ma.manager@tradeway.com` |
| 🇩🇿 Algeria Account Manager | `dz.manager@tradeway.com` |
| TL Sales (Uber EG) | `eg.uber.tl.sales@tradeway.com` |
| Sales Agent (Sara) | `eg.uber.sales1@tradeway.com` |
| Sales Agent (Mohamed) | `eg.uber.sales2@tradeway.com` |
| Sales Agent (Noura) | `eg.uber.sales3@tradeway.com` |
| TL Activation | `eg.uber.tl.activ@tradeway.com` |
| TL Driving | `eg.uber.tl.drive@tradeway.com` |
| Activation Agent | `eg.uber.activ1@tradeway.com` |
| Driving Agent | `eg.uber.drive1@tradeway.com` |
| QA Specialist | `qa@tradeway.com` |

---

## 🧪 API Quick Test

### 1. Login

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"super@tradeway.com","password":"Password@123"}'
```

Response:
```json
{
  "accessToken": "eyJhbG...",
  "refreshToken": "eyJhbG...",
  "user": { "id":"...", "name":"Super Admin", "role":"super_admin" }
}
```

### 2. Get your profile + scope

```bash
curl http://localhost:3000/api/v1/auth/me \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### 3. List leads (filtered by your scope automatically)

```bash
curl http://localhost:3000/api/v1/enrollments \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

- Super Admin → sees all leads (all countries, all companies)
- Egypt Manager → sees only Egypt leads
- Sara (Sales Agent) → sees only leads assigned to her
- TL Sales → sees team's leads + unassigned ones

---

## 🔒 Visibility Engine (RBAC)

The core of the system is in `apps/api/src/lib/rbac.ts`. Every request passes through:

1. **Authentication** — who is making the request? (JWT)
2. **Authorization** — does their role allow this action? (capabilities)
3. **Scope filtering** — what data can they see? (automatic WHERE clauses)

### Role Hierarchy

```
Super Admin  (level 100)           — sees everything
    │
    ├─ Operations Manager (90)     — sees all countries (read-only)
    │
    └─ Account Manager (80)        — sees their country only
            │
            └─ Team Leader (60)    — sees their team only
                    │
                    └─ Agent (30)  — sees only assigned leads
```

---

## 📋 API Endpoints

### Auth
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/logout-all`
- `GET  /api/v1/auth/me`

### Users
- `GET    /api/v1/users`
- `GET    /api/v1/users/:id`
- `POST   /api/v1/users` — create (admin/manager only)
- `PUT    /api/v1/users/:id`
- `POST   /api/v1/users/:id/assignments`
- `DELETE /api/v1/users/:id/assignments/:assignmentId`
- `PUT    /api/v1/users/:id/leave`

### Companies & Countries
- `GET  /api/v1/companies`
- `POST /api/v1/companies`
- `GET  /api/v1/countries`
- `POST /api/v1/countries`
- `POST /api/v1/countries/:id/holidays`
- `GET  /api/v1/company-countries`
- `GET  /api/v1/company-countries/:id`
- `POST /api/v1/company-countries`

### Contacts (الكباتن)
- `GET  /api/v1/contacts`
- `GET  /api/v1/contacts/:id`
- `POST /api/v1/contacts`
- `POST /api/v1/contacts/check-duplicate` — مهم للـ multi-company tracking
- `PUT  /api/v1/contacts/:id`

### Enrollments (الليدز)
- `GET /api/v1/enrollments`
- `GET /api/v1/enrollments/:id`
- `POST /api/v1/enrollments`
- `PUT /api/v1/enrollments/:id`
- `PUT /api/v1/enrollments/:id/stage` — change stage (triggers approval if required)
- `PUT /api/v1/enrollments/:id/assign` — assign to agent
- `POST /api/v1/enrollments/:id/notes`
- `GET /api/v1/enrollments/:id/timeline`

### Pipeline
- `GET    /api/v1/pipeline/:ccId/stages`
- `POST   /api/v1/pipeline/:ccId/stages`
- `PUT    /api/v1/pipeline/:ccId/stages/:id`
- `PUT    /api/v1/pipeline/:ccId/stages/reorder`
- `DELETE /api/v1/pipeline/:ccId/stages/:id`

---

## 🛠️ Development Commands

```bash
# Root commands
pnpm dev:api                  # Start API in watch mode

# API commands (run from apps/api/)
pnpm dev                      # Start with hot reload
pnpm build                    # Build for production
pnpm db:migrate               # Run migrations
pnpm db:seed                  # Seed database
pnpm db:reset                 # Reset + migrate + seed
pnpm db:studio                # Prisma Studio (DB GUI)
pnpm typecheck                # Check TypeScript types
```

---

## 📊 Database Overview

Phase 1 schema includes:

| Table | Purpose |
|-------|---------|
| `companies` | الشركات (أوبر، إن درايف) |
| `countries` | الدول |
| `company_countries` | شركة-في-دولة (أوبر مصر، إلخ) |
| `users` | الموظفين (11 role) |
| `user_assignments` | ربط user بشركة-دولة وتيم + parent |
| `contacts` | الكباتن (سجل واحد لكل شخص) |
| `enrollments` | تسجيل الكابتن في شركة معينة |
| `pipeline_stages` | مراحل الفانل (قابلة للتخصيص لكل شركة-دولة) |
| `enrollment_timeline` | سجل كامل لكل الأحداث |
| `approvals` | طلبات الموافقة |
| `lead_sources_config` | مصادر الليدز (قابلة للإضافة) |
| `user_sessions` | جلسات الـ refresh tokens |
| `holidays` | عطلات الدول |
| `audit_logs` | سجل التدقيق |

---

## 🚧 Phase 1 Scope (المرحلة الحالية)

✅ **Done:**
- Monorepo + Docker setup
- Complete database schema
- Authentication (JWT with refresh rotation)
- Full RBAC with Scope engine
- Users + Hierarchy management
- Companies, Countries, Company-Countries CRUD
- Contacts + Enrollments (with multi-company support)
- Configurable Pipeline stages (event-driven)
- Approvals system (basic)
- Timeline tracking
- Comprehensive seed data

🔜 **Next phases:**
- **Phase 2:** Distribution engine + SLA + Full approvals workflow + Frontend UIs
- **Phase 3:** Meta/TikTok webhooks + Google Sheets sync (Hero Dashboard) + Accounting integration
- **Phase 4:** Bonus system + Competitions + Leaderboard + QA
- **Phase 5:** Analytics + Heatmap + Cohort analysis + Executive dashboard

---

## 🔧 Troubleshooting

### "Cannot connect to database"
```bash
docker compose ps           # check if postgres is running
docker compose restart postgres
```

### "Migration failed"
```bash
cd apps/api
pnpm db:reset               # nuke everything and start fresh
```

### JWT errors after code changes
Clear all sessions:
```bash
# In postgres
DELETE FROM user_sessions;
```

---

## 📝 License

Proprietary — Trade Way / Captain Masr © 2026
