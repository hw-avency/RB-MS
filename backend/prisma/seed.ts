import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const breakglassEmail = (process.env.BREAKGLASS_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@example.com').trim().toLowerCase();
  const breakglassPassword = process.env.BREAKGLASS_PASSWORD ?? process.env.ADMIN_PASSWORD;

  if (!breakglassPassword) {
    throw new Error('BREAKGLASS_PASSWORD (or ADMIN_PASSWORD fallback) is required to run seed.');
  }

  const passwordHash = await bcrypt.hash(breakglassPassword, 12);

  await prisma.user.upsert({
    where: { email: breakglassEmail },
    update: {
      displayName: 'Breakglass Admin',
      passwordHash,
      role: 'admin',
      isActive: true
    },
    create: {
      email: breakglassEmail,
      displayName: 'Breakglass Admin',
      passwordHash,
      role: 'admin',
      isActive: true
    }
  });

  console.log(`Seed complete. Breakglass admin ensured: ${breakglassEmail}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
