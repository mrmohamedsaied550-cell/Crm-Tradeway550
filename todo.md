# CRM Lead Detail Enhancement — Todo

## Backend: Database Models (Migration 0013)
- [ ] LeadStatus model — substatus within each stage (e.g. "No Answer" inside "Contacted")
- [ ] LeadDocument model — document checklist per lead (ID card, license, etc.)
- [ ] LeadFollowUp model — scheduled follow-ups with date, method, reminder
- [ ] Add `statusId` field to Lead model
- [ ] Add `statusCode` to lead list/detail query includes

## Backend: API Endpoints
- [ ] CRUD for LeadStatus (admin: create/list/update/delete statuses per stage)
- [ ] PATCH leads/:id/status — change lead substatus
- [ ] CRUD for LeadDocument (list/create/update per lead)
- [ ] CRUD for LeadFollowUp (list/create/update/complete per lead)
- [ ] Advanced filter endpoint (leads/search with AND/OR conditions)
- [ ] GET leads/:id/conversations — lookup WhatsApp conversations by lead

## Backend: Pipeline Registry Updates
- [ ] Add default statuses per stage to pipeline.registry.ts
- [ ] Add 'status_change', 'follow_up', 'document' to ACTIVITY_TYPES

## Frontend: API Types + Client
- [ ] Update api-types.ts with LeadStatus, LeadDocument, LeadFollowUp types
- [ ] Update api.ts with new endpoints
- [ ] Update Lead type to include statusId + status relation

## Frontend: Lead Detail Page Redesign
- [ ] Stage + Status section (prominent display with change button)
- [ ] Add Action modal (5 categories: Lifecycle, Profile, Documents, Partner, Note)
- [ ] WhatsApp popup panel (slide-in from right)
- [ ] Call button (tel: link)
- [ ] Follow-up scheduling modal
- [ ] Timeline with scroll + SLA grouping
- [ ] Documents progress section
- [ ] Pipeline tracker visual

## Frontend: Leads List Page Redesign
- [ ] Stage filter tabs with Status dropdown sub-filter
- [ ] Advanced Query Builder modal (AND/OR conditions)
- [ ] Status column in table
- [ ] Improved table with hover actions
