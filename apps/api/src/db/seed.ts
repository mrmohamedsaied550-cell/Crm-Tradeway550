import 'dotenv/config';
import { db, pool } from './client';
import { hashPassword } from '../lib/password';
import { users } from './schema/users';
import { companies, countries, companyCountries } from './schema/companies';
import { stages, leadStatuses, rejectReasons } from './schema/pipeline';
import { contacts } from './schema/contacts';
import { enrollments } from './schema/enrollments';
import { eq } from 'drizzle-orm';

async function main() {
  console.log('🌱 Seeding database...');

  const password = await hashPassword('Password@123');

  // ===== Users =====
  const baseUsers = [
    { name: 'Super Admin', email: 'super@tradeway.com', role: 'super_admin' as const },
    { name: 'Operations Manager', email: 'manager@tradeway.com', role: 'manager' as const, countryCode: 'EG' },
    { name: 'Egypt TL Sales', email: 'tl.sales@tradeway.com', role: 'team_leader' as const, countryCode: 'EG' },
    { name: 'Sara (Sales)', email: 'sara@tradeway.com', role: 'sales_agent' as const, countryCode: 'EG' },
    { name: 'Mohamed (Sales)', email: 'mohamed@tradeway.com', role: 'sales_agent' as const, countryCode: 'EG' },
    { name: 'Noura (Sales)', email: 'noura@tradeway.com', role: 'sales_agent' as const, countryCode: 'EG' },
  ];
  for (const u of baseUsers) {
    const existing = await db.select().from(users).where(eq(users.email, u.email)).limit(1);
    if (existing.length === 0) {
      await db.insert(users).values({ ...u, passwordHash: password });
      console.log(`  ✓ user: ${u.email}`);
    }
  }

  // ===== Countries =====
  const countriesSeed = [
    { code: 'EG', nameAr: 'مصر', nameEn: 'Egypt', currency: 'EGP', timezone: 'Africa/Cairo', flagEmoji: '🇪🇬' },
    { code: 'SA', nameAr: 'السعودية', nameEn: 'Saudi Arabia', currency: 'SAR', timezone: 'Asia/Riyadh', flagEmoji: '🇸🇦' },
    { code: 'MA', nameAr: 'المغرب', nameEn: 'Morocco', currency: 'MAD', timezone: 'Africa/Casablanca', flagEmoji: '🇲🇦' },
    { code: 'DZ', nameAr: 'الجزائر', nameEn: 'Algeria', currency: 'DZD', timezone: 'Africa/Algiers', flagEmoji: '🇩🇿' },
  ];
  for (const c of countriesSeed) {
    const existing = await db.select().from(countries).where(eq(countries.code, c.code)).limit(1);
    if (existing.length === 0) {
      await db.insert(countries).values(c);
      console.log(`  ✓ country: ${c.nameAr}`);
    }
  }

  // ===== Companies =====
  const companiesSeed = [
    { code: 'UBER', nameAr: 'أوبر', nameEn: 'Uber' },
    { code: 'INDRIVE', nameAr: 'إن درايف', nameEn: 'inDrive' },
    { code: 'DIDI', nameAr: 'ديدي', nameEn: 'DiDi' },
    { code: 'YANGO', nameAr: 'يانغو', nameEn: 'Yango' },
  ];
  for (const c of companiesSeed) {
    const existing = await db.select().from(companies).where(eq(companies.code, c.code)).limit(1);
    if (existing.length === 0) {
      await db.insert(companies).values(c);
      console.log(`  ✓ company: ${c.nameAr}`);
    }
  }

  // ===== Company-Countries =====
  const allCompanies = await db.select().from(companies);
  const uberId = allCompanies.find((c) => c.code === 'UBER')!.id;
  const indriveId = allCompanies.find((c) => c.code === 'INDRIVE')!.id;

  const ccSeed = [
    { companyId: uberId, countryCode: 'EG' },
    { companyId: uberId, countryCode: 'SA' },
    { companyId: indriveId, countryCode: 'EG' },
    { companyId: indriveId, countryCode: 'MA' },
  ];
  for (const cc of ccSeed) {
    try {
      await db.insert(companyCountries).values(cc);
      console.log(`  ✓ company-country: ${cc.companyId.slice(0, 6)}/${cc.countryCode}`);
    } catch {
      // already exists
    }
  }

  // ===== Default Lead Statuses (global) =====
  const statusSeed = [
    { code: 'new', nameAr: 'جديد', nameEn: 'New', color: '#3b82f6', order: 0 },
    { code: 'no_answer', nameAr: 'لم يرد', nameEn: 'No Answer', color: '#f59e0b', order: 1 },
    { code: 'contacted', nameAr: 'تم التواصل', nameEn: 'Contacted', color: '#10b981', order: 2 },
    { code: 'follow_up', nameAr: 'متابعة', nameEn: 'Follow Up', color: '#8b5cf6', order: 3 },
    { code: 'rejected', nameAr: 'مرفوض', nameEn: 'Rejected', color: '#ef4444', order: 4, isTerminal: true },
  ];
  for (const s of statusSeed) {
    const existing = await db
      .select()
      .from(leadStatuses)
      .where(eq(leadStatuses.code, s.code))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(leadStatuses).values(s);
      console.log(`  ✓ status: ${s.nameAr}`);
    }
  }

  // ===== Default Stages (global) =====
  const stagesSeed = [
    { code: 'new_lead', nameAr: 'ليد جديد', nameEn: 'New Lead', teamType: 'sales' as const, order: 0, color: '#3b82f6' },
    { code: 'awaiting_docs', nameAr: 'في انتظار المستندات', nameEn: 'Awaiting Documents', teamType: 'sales' as const, order: 1, color: '#f59e0b', slaMinutes: 4320 },
    { code: 'awaiting_activation', nameAr: 'في انتظار التفعيل', nameEn: 'Awaiting Activation', teamType: 'activation' as const, order: 2, color: '#8b5cf6', approvalRequired: 'team_leader' as const },
    { code: 'active', nameAr: 'نشط', nameEn: 'Active', teamType: 'activation' as const, order: 3, color: '#10b981' },
    { code: 'dft', nameAr: 'أول رحلة (DFT)', nameEn: 'DFT - First Trip', teamType: 'driving' as const, order: 4, color: '#06b6d4', slaMinutes: 10080 },
    { code: 'completed', nameAr: 'مكتمل', nameEn: 'Completed', teamType: 'driving' as const, order: 5, color: '#22c55e', isTerminal: true },
  ];
  for (const s of stagesSeed) {
    const existing = await db.select().from(stages).where(eq(stages.code, s.code)).limit(1);
    if (existing.length === 0) {
      await db.insert(stages).values(s);
      console.log(`  ✓ stage: ${s.nameAr}`);
    }
  }

  // ===== Reject Reasons =====
  const reasonsSeed = [
    { code: 'unsupported_city', nameAr: 'مدينة غير مدعومة', nameEn: 'Unsupported City', category: 'eligibility' },
    { code: 'underage', nameAr: 'السن صغير', nameEn: 'Underage', category: 'eligibility' },
    { code: 'no_papers', nameAr: 'أوراق ناقصة', nameEn: 'Missing Papers', category: 'documents' },
    { code: 'no_vehicle', nameAr: 'لا يوجد مركبة', nameEn: 'No Vehicle', category: 'eligibility' },
    { code: 'not_interested', nameAr: 'غير مهتم', nameEn: 'Not Interested', category: 'response' },
    { code: 'wrong_number', nameAr: 'رقم خطأ', nameEn: 'Wrong Number', category: 'response' },
  ];
  for (const r of reasonsSeed) {
    const existing = await db
      .select()
      .from(rejectReasons)
      .where(eq(rejectReasons.code, r.code))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(rejectReasons).values(r);
      console.log(`  ✓ reason: ${r.nameAr}`);
    }
  }

  // ===== Sample Leads =====
  const allCC = await db.select().from(companyCountries);
  const uberEg = allCC.find((c) => c.companyId === uberId && c.countryCode === 'EG');
  const sara = (await db.select().from(users).where(eq(users.email, 'sara@tradeway.com')).limit(1))[0];
  const newStatus = (await db.select().from(leadStatuses).where(eq(leadStatuses.code, 'new')).limit(1))[0];
  const newStage = (await db.select().from(stages).where(eq(stages.code, 'new_lead')).limit(1))[0];

  if (uberEg && sara && newStatus && newStage) {
    const sampleLeads = [
      { fullName: 'أحمد محمد', phone: '01000000001', city: 'القاهرة' },
      { fullName: 'محمود علي', phone: '01000000002', city: 'الإسكندرية' },
      { fullName: 'كريم إبراهيم', phone: '01000000003', city: 'الجيزة' },
    ];
    for (const lead of sampleLeads) {
      const existing = await db.select().from(contacts).where(eq(contacts.phone, lead.phone)).limit(1);
      if (existing.length === 0) {
        await db.insert(contacts).values({ ...lead, countryCode: 'EG' });
        const [c] = await db.select().from(contacts).where(eq(contacts.phone, lead.phone)).limit(1);
        await db.insert(enrollments).values({
          contactId: c!.id,
          companyCountryId: uberEg.id,
          assignedUserId: sara.id,
          assignedAt: new Date(),
          currentStageId: newStage.id,
          currentStatusId: newStatus.id,
          source: 'manual',
        });
        console.log(`  ✓ lead: ${lead.fullName}`);
      }
    }
  }

  console.log('\n✅ Seed complete.');
  console.log('\n📋 Test accounts (password = Password@123):');
  for (const u of baseUsers) console.log(`  - ${u.email} (${u.role})`);

  await pool.end();
}

main().catch((err) => {
  console.error('❌ Seed failed:', err);
  pool.end();
  process.exit(1);
});
