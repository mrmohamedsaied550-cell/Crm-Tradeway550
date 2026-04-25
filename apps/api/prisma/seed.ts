import { PrismaClient, type Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const PASSWORD = 'Password@123';

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  console.log('Seeding companies + countries...');
  const [uber, indrive] = await Promise.all([
    prisma.company.upsert({
      where: { slug: 'uber' },
      update: {},
      create: { name: 'Uber', slug: 'uber' },
    }),
    prisma.company.upsert({
      where: { slug: 'indrive' },
      update: {},
      create: { name: 'inDrive', slug: 'indrive' },
    }),
  ]);

  const countryDefs = [
    { code: 'EG', name: 'Egypt', currency: 'EGP' },
    { code: 'SA', name: 'Saudi Arabia', currency: 'SAR' },
    { code: 'MA', name: 'Morocco', currency: 'MAD' },
    { code: 'DZ', name: 'Algeria', currency: 'DZD' },
  ];
  const countries = await Promise.all(
    countryDefs.map((c) =>
      prisma.country.upsert({
        where: { code: c.code },
        update: {},
        create: c,
      }),
    ),
  );
  const byCode = Object.fromEntries(countries.map((c) => [c.code, c]));

  console.log('Seeding company-countries...');
  const ccPairs = [
    { companyId: uber.id, countryId: byCode.EG!.id, key: 'uber-eg' },
    { companyId: uber.id, countryId: byCode.SA!.id, key: 'uber-sa' },
    { companyId: uber.id, countryId: byCode.MA!.id, key: 'uber-ma' },
    { companyId: uber.id, countryId: byCode.DZ!.id, key: 'uber-dz' },
    { companyId: indrive.id, countryId: byCode.EG!.id, key: 'indrive-eg' },
  ];
  const ccs = await Promise.all(
    ccPairs.map(async (p) => {
      const cc = await prisma.companyCountry.upsert({
        where: { companyId_countryId: { companyId: p.companyId, countryId: p.countryId } },
        update: {},
        create: { companyId: p.companyId, countryId: p.countryId },
      });
      return { ...cc, key: p.key };
    }),
  );
  const ccByKey = Object.fromEntries(ccs.map((c) => [c.key, c]));

  console.log('Seeding pipeline stages for each CC...');
  const defaultStages = [
    { key: 'new', name: 'New Lead', order: 1, requiresApproval: false },
    { key: 'contacted', name: 'Contacted', order: 2, requiresApproval: false },
    { key: 'docs_pending', name: 'Documents Pending', order: 3, requiresApproval: false },
    { key: 'docs_uploaded', name: 'Documents Uploaded', order: 4, requiresApproval: false },
    { key: 'activation', name: 'Activation', order: 5, requiresApproval: false },
    {
      key: 'activated',
      name: 'Activated',
      order: 6,
      requiresApproval: true,
      triggersEvent: 'driver_activated',
      isTerminal: false,
    },
    {
      key: 'rejected',
      name: 'Rejected',
      order: 7,
      requiresApproval: true,
      isTerminal: true,
    },
  ];
  for (const cc of ccs) {
    for (const st of defaultStages) {
      await prisma.pipelineStage.upsert({
        where: {
          companyCountryId_key: { companyCountryId: cc.id, key: st.key },
        },
        update: {},
        create: { ...st, companyCountryId: cc.id },
      });
    }
  }

  console.log('Seeding users (15 test accounts)...');

  const upsertUser = (email: string, name: string, role: Role) =>
    prisma.user.upsert({
      where: { email },
      update: {},
      create: { email, name, role, passwordHash },
    });

  const superAdmin = await upsertUser('super@tradeway.com', 'Super Admin', 'super_admin');
  const opsManager = await upsertUser('ops@tradeway.com', 'Operations Manager', 'ops_manager');
  const egManager = await upsertUser('eg.manager@tradeway.com', 'Egypt AM', 'account_manager');
  const saManager = await upsertUser('sa.manager@tradeway.com', 'Saudi AM', 'account_manager');
  const maManager = await upsertUser('ma.manager@tradeway.com', 'Morocco AM', 'account_manager');
  const dzManager = await upsertUser('dz.manager@tradeway.com', 'Algeria AM', 'account_manager');

  const tlSales = await upsertUser('eg.uber.tl.sales@tradeway.com', 'TL Sales (Uber EG)', 'tl_sales');
  const sara = await upsertUser('eg.uber.sales1@tradeway.com', 'Sara (Sales)', 'sales_agent');
  const mohamed = await upsertUser(
    'eg.uber.sales2@tradeway.com',
    'Mohamed (Sales)',
    'sales_agent',
  );
  const noura = await upsertUser('eg.uber.sales3@tradeway.com', 'Noura (Sales)', 'sales_agent');

  const tlActiv = await upsertUser(
    'eg.uber.tl.activ@tradeway.com',
    'TL Activation (Uber EG)',
    'tl_activation',
  );
  const tlDriv = await upsertUser(
    'eg.uber.tl.drive@tradeway.com',
    'TL Driving (Uber EG)',
    'tl_driving',
  );
  const activAgent = await upsertUser(
    'eg.uber.activ1@tradeway.com',
    'Activation Agent',
    'activation_agent',
  );
  const drivAgent = await upsertUser(
    'eg.uber.drive1@tradeway.com',
    'Driving Agent',
    'driving_agent',
  );
  const qa = await upsertUser('qa@tradeway.com', 'QA Specialist', 'qa_specialist');

  console.log('Seeding assignments...');
  // Country managers → all CCs in their country
  const assignManager = async (mgrId: string, countryCode: string) => {
    for (const cc of ccs) {
      const ccCountry = await prisma.country.findFirst({
        where: { id: (await prisma.companyCountry.findUniqueOrThrow({ where: { id: cc.id } })).countryId },
      });
      if (ccCountry?.code === countryCode) {
        await prisma.userAssignment.upsert({
          where: { userId_companyCountryId: { userId: mgrId, companyCountryId: cc.id } },
          update: {},
          create: { userId: mgrId, companyCountryId: cc.id, parentUserId: null },
        });
      }
    }
  };
  await assignManager(egManager.id, 'EG');
  await assignManager(saManager.id, 'SA');
  await assignManager(maManager.id, 'MA');
  await assignManager(dzManager.id, 'DZ');

  // Uber-EG team: TLs report to egManager; agents report to TL
  const uberEg = ccByKey['uber-eg']!;
  const ensureAssignment = (userId: string, parentId: string | null) =>
    prisma.userAssignment.upsert({
      where: { userId_companyCountryId: { userId, companyCountryId: uberEg.id } },
      update: { parentUserId: parentId },
      create: { userId, companyCountryId: uberEg.id, parentUserId: parentId },
    });

  await ensureAssignment(tlSales.id, egManager.id);
  await ensureAssignment(tlActiv.id, egManager.id);
  await ensureAssignment(tlDriv.id, egManager.id);
  await ensureAssignment(sara.id, tlSales.id);
  await ensureAssignment(mohamed.id, tlSales.id);
  await ensureAssignment(noura.id, tlSales.id);
  await ensureAssignment(activAgent.id, tlActiv.id);
  await ensureAssignment(drivAgent.id, tlDriv.id);

  console.log('Seeding lead source config...');
  const sources = [
    { key: 'meta', label: 'Meta Ads' },
    { key: 'tiktok', label: 'TikTok Ads' },
    { key: 'walk_in', label: 'Walk-in' },
    { key: 'referral', label: 'Referral' },
  ];
  for (const s of sources) {
    await prisma.leadSourceConfig.upsert({
      where: { key: s.key },
      update: {},
      create: s,
    });
  }

  console.log('Seeding sample contacts + enrollments...');
  const sampleContacts = [
    { phone: '+201001234567', fullName: 'Ahmed Hassan', countryId: byCode.EG!.id, assignee: sara.id },
    { phone: '+201001234568', fullName: 'Mostafa Ali', countryId: byCode.EG!.id, assignee: sara.id },
    { phone: '+201001234569', fullName: 'Omar Sayed', countryId: byCode.EG!.id, assignee: mohamed.id },
    { phone: '+201001234570', fullName: 'Khaled Mahmoud', countryId: byCode.EG!.id, assignee: noura.id },
    { phone: '+201001234571', fullName: 'Yousef Adel', countryId: byCode.EG!.id, assignee: null },
  ];
  const newStage = await prisma.pipelineStage.findUniqueOrThrow({
    where: { companyCountryId_key: { companyCountryId: uberEg.id, key: 'new' } },
  });
  for (const c of sampleContacts) {
    const contact = await prisma.contact.upsert({
      where: { countryId_phone: { countryId: c.countryId, phone: c.phone } },
      update: {},
      create: { countryId: c.countryId, phone: c.phone, fullName: c.fullName },
    });
    const existing = await prisma.enrollment.findUnique({
      where: {
        contactId_companyCountryId: { contactId: contact.id, companyCountryId: uberEg.id },
      },
    });
    if (!existing) {
      const e = await prisma.enrollment.create({
        data: {
          contactId: contact.id,
          companyCountryId: uberEg.id,
          stageId: newStage.id,
          assigneeId: c.assignee,
          createdById: tlSales.id,
          source: 'meta',
        },
      });
      await prisma.enrollmentTimeline.create({
        data: {
          enrollmentId: e.id,
          actorId: tlSales.id,
          type: 'created',
          payload: { source: 'meta', stageKey: 'new' },
        },
      });
      if (c.assignee) {
        await prisma.enrollmentTimeline.create({
          data: {
            enrollmentId: e.id,
            actorId: tlSales.id,
            type: 'assigned',
            payload: { from: null, to: c.assignee },
          },
        });
      }
    }
  }

  console.log('Done. All accounts use password:', PASSWORD);
  // Reference unused vars to keep TS strict happy when noUnusedLocals is on:
  void [superAdmin, opsManager, qa];
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
