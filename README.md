# 🚗 Trade Way CRM

نظام إدارة علاقات العملاء (CRM) لشركة **Trade Way / Captain Masr** — مخصص لإدارة تسجيل السائقين في شركات النقل التشاركي (أوبر، إن درايف، ديدي، يانغو) عبر دول متعددة.

> النظام مبني على نفس البنية التحتية ولغة التصميم الخاصة بنظام الحسابات الحالي لـ Trade Way.

---

## 🏗️ البنية المعمارية

```
crm-tradeway/
├── apps/
│   ├── api/              # Backend (Fastify + TypeScript + Drizzle + MySQL)
│   └── web/              # Frontend (React + Vite + TypeScript + Tailwind v4 + shadcn/ui)
├── packages/
│   └── shared/           # أنواع مشتركة بين الـ API والـ Web
├── docker-compose.yml    # MySQL + Redis
└── package.json          # pnpm workspaces
```

### Tech Stack

| الطبقة | التقنية |
|--------|---------|
| **Backend** | Node.js 20+ · Fastify · TypeScript · Drizzle ORM |
| **Database** | MySQL 8.0 |
| **Cache/Queue** | Redis 7 (مجهز للمراحل القادمة) |
| **Auth** | JWT (Access + Refresh مع rotation) — Standalone |
| **Validation** | Zod |
| **Frontend** | React 18 · Vite · TypeScript · TailwindCSS v4 · shadcn/ui |
| **State** | Zustand · TanStack Query |
| **Charts** | Recharts |
| **Package Manager** | pnpm 9 (workspaces) |

---

## 🎨 نظام التصميم

- **اللون الأساسي:** أخضر Trade Way `oklch(0.65 0.18 145)`
- **القائمة الجانبية:** رمادي-أخضر داكن `oklch(0.25 0.03 160)` بنص فاتح
- **التخطيط:** `DashboardLayout` بقائمة جانبية ثابتة + شريط علوي
- **التفاعلات:** Slide-over panels لكل التفاصيل (مفيش page reload)
- **اللغة:** ثنائي اللغة (عربي/إنجليزي) + RTL كامل
- **الخط:** Cairo (عربي) · Inter (إنجليزي)

---

## 🚀 البدء السريع

### المتطلبات
- Node.js 20+
- pnpm 9+ (`npm install -g pnpm`)
- Docker + Docker Compose

### الإعداد

```bash
# 1. تثبيت الحزم
pnpm install

# 2. تشغيل MySQL + Redis
docker compose up -d

# 3. إعداد متغيرات البيئة
cd apps/api
cp .env.example .env

# 4. تطبيق الـ schema + بيانات تجريبية
pnpm db:push      # ينشئ الجداول مباشرة من الـ schema
pnpm db:seed      # بيانات تجريبية

# 5. تشغيل الـ API + الـ Web
cd ../..
pnpm dev          # يشغل الاثنين بالتوازي
```

- API: http://localhost:3000
- Web: http://localhost:5173

---

## 🔐 الحسابات التجريبية

كل الحسابات بكلمة سر: `Password@123`

| الدور | البريد |
|------|---------|
| 🔐 Super Admin | `super@tradeway.com` |
| 🔐 Manager | `manager@tradeway.com` |
| 🇪🇬 Team Leader Sales | `tl.sales@tradeway.com` |
| 🟢 Sales Agent (Sara) | `sara@tradeway.com` |
| 🟢 Sales Agent (Mohamed) | `mohamed@tradeway.com` |
| 🟢 Sales Agent (Noura) | `noura@tradeway.com` |

---

## 👥 نظام الصلاحيات (RBAC)

| الدور | النطاق | الصلاحيات الأساسية |
|------|--------|----------------------|
| **Super Admin** | كل النظام | إعدادات النظام + إدارة المستخدمين + كل الموديولز |
| **Manager** | كل الدول (أو دولة محددة) | إدارة الحملات + التقارير + الموافقات |
| **Team Leader** | تيمه فقط | إدارة فريقه + توزيع الليدز + الموافقات |
| **Sales Agent** | ليدزه فقط | تحديث الحالات + المكالمات + الملاحظات |

---

## 📋 الـ API Endpoints

### Auth
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/logout-all`
- `GET  /api/v1/auth/me`

### Users & Teams
- `GET  /api/v1/users`
- `GET  /api/v1/users/:id`
- `POST /api/v1/users`
- `PUT  /api/v1/users/:id`
- `GET  /api/v1/users/teams/list`
- `POST /api/v1/users/teams`

### Companies & Markets
- `GET  /api/v1/companies`
- `POST /api/v1/companies`
- `GET  /api/v1/companies/countries`
- `POST /api/v1/companies/countries`
- `GET  /api/v1/companies/company-countries`
- `POST /api/v1/companies/company-countries`

### Pipeline (Stages, Statuses, Reasons)
- `GET    /api/v1/pipeline/stages`
- `POST   /api/v1/pipeline/stages`
- `PUT    /api/v1/pipeline/stages/:id`
- `DELETE /api/v1/pipeline/stages/:id`
- `PUT    /api/v1/pipeline/stages/reorder`
- `GET    /api/v1/pipeline/statuses`
- `POST   /api/v1/pipeline/statuses`
- `PUT    /api/v1/pipeline/statuses/:id`
- `DELETE /api/v1/pipeline/statuses/:id`
- `GET    /api/v1/pipeline/reject-reasons`
- `POST   /api/v1/pipeline/reject-reasons`

### Leads (Contacts + Enrollments)
- `GET    /api/v1/leads` — مع pagination + filtering + RBAC scope
- `GET    /api/v1/leads/:id`
- `POST   /api/v1/leads`
- `PUT    /api/v1/leads/:id`
- `DELETE /api/v1/leads/:id` — soft delete
- `POST   /api/v1/leads/check-duplicate` — للتحقق من تكرار رقم الهاتف
- `POST   /api/v1/leads/:id/notes`
- `POST   /api/v1/leads/:id/calls`
- `GET    /api/v1/leads/:id/timeline`

### Campaigns
- `GET  /api/v1/campaigns`
- `POST /api/v1/campaigns`
- `PUT  /api/v1/campaigns/:id`
- `POST /api/v1/campaigns/:id/rotate-secret`

### Webhooks (لاستقبال الليدز من الإعلانات)
- `GET  /api/v1/webhooks/meta/:campaignId` — Facebook handshake
- `POST /api/v1/webhooks/meta/:campaignId?secret=...`
- `POST /api/v1/webhooks/tiktok/:campaignId?secret=...`
- `POST /api/v1/webhooks/generic/:campaignId?secret=...`

### Dashboard
- `GET /api/v1/dashboard/kpis`
- `GET /api/v1/dashboard/by-source`
- `GET /api/v1/dashboard/by-stage`

---

## 📊 نموذج البيانات

| Table | الوظيفة |
|-------|---------|
| `users` | الموظفين (4 أدوار) |
| `teams` | تيمات Sales / Activation / Driving |
| `companies` | الشركات (Uber, inDrive, DiDi, Yango) |
| `countries` | الدول |
| `company_countries` | شركة × دولة (المسوّق فعلياً) |
| **`contacts`** | **بيانات الكابتن (Unique بالهاتف)** |
| **`enrollments`** | **تسجيل الكابتن في شركة-دولة معينة** |
| `stages` | مراحل الفانل (قابلة للتخصيص) |
| `lead_statuses` | الحالات الفرعية |
| `reject_reasons` | أسباب الرفض الموحدة |
| `enrollment_documents` | مستندات السائق |
| `campaigns` | حملات التسويق |
| `campaign_routing_state` | حالة round-robin لكل حملة |
| `activities` | كل الأحداث (Timeline) |
| `user_sessions` | جلسات الـ refresh tokens |

### 🔑 الفكرة الأساسية: Contact + Enrollments

**ليه الفصل ده مهم؟** السائق الواحد ممكن يكون مسجل في أوبر وإن درايف في نفس الوقت من غير تكرار بيانات.

```
Contact: أحمد، 01012345678
 ├── Enrollment #1: أوبر-مصر | Sales: سارة
 └── Enrollment #2: إن درايف-مصر | Sales: نورا
```

في الـ UI بيظهر "Lead" واحد، لكن البنية تحت بتدّي مرونة كاملة.

---

## 🛠️ أوامر التطوير

```bash
# Root
pnpm dev               # API + Web بالتوازي
pnpm dev:api           # API فقط
pnpm dev:web           # Web فقط
pnpm build             # build كل شيء
pnpm typecheck         # type-check كل الـ packages

# Database (من الـ root)
pnpm db:generate       # توليد migration files من الـ schema
pnpm db:push           # تطبيق الـ schema مباشرة (dev)
pnpm db:migrate        # تطبيق الـ migrations (production)
pnpm db:seed           # بيانات تجريبية
pnpm db:studio         # Drizzle Studio (GUI)
```

---

## 🛣️ خريطة الطريق

### ✅ المرحلة 1 — الـ CRM الأساسي (تم)
- بنية المشروع (monorepo + Docker)
- Drizzle Schema كامل (14 جدول)
- JWT Auth + Refresh rotation
- RBAC بـ 4 أدوار + Capabilities + Scope
- Companies, Countries, Markets
- Pipeline Builder (Stages + Statuses + Reasons)
- Leads CRUD + Activity Timeline + Multi-company
- Dashboard KPIs + Charts
- Design System كامل (Tailwind v4 + shadcn/ui)
- Slide-over panels + RTL

### 🔄 المرحلة 2 — التوزيع والأتمتة (3 أسابيع)
- محرك التوزيع الكامل (round_robin/percentage/capacity/performance/hybrid)
- Webhooks: Meta Lead Ads + TikTok (التطبيق الكامل)
- استيراد جماعي من Excel
- Google Sheets Sync (ثنائي الاتجاه)
- نظام الموافقات + رفع المستندات

### 🔄 المرحلة 3 — التواصل والتقارير (أسبوعين)
- WhatsApp Business API integration
- Inbox موحد داخل تفاصيل الليد
- رسائل آلية على تغيير الحالة
- Broadcasts للشرائح
- تقارير تفصيلية + Heatmap + Funnel

---

## 🔧 استكشاف الأخطاء

### "Cannot connect to database"
```bash
docker compose ps           # تأكد إن mysql شغال
docker compose restart mysql
```

### "Migration / push failed"
```bash
cd apps/api
pnpm db:push                # يطبق الـ schema مباشرة
```

### مشاكل في الـ JWT بعد تغيير الكود
```sql
-- في mysql
DELETE FROM user_sessions;
```

---

## 📝 الترخيص

ملكية خاصة — Trade Way / Captain Masr © 2026
