import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    throw new Error('ADMIN_PASSWORD is required to run seed.');
  }

  const passwordHash = await bcrypt.hash(adminPassword, 12);

  await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {
      displayName: 'Breakglass Admin',
      passwordHash,
      role: 'admin'
    },
    create: {
      email: 'admin@example.com',
      displayName: 'Breakglass Admin',
      passwordHash,
      role: 'admin'
    }
  });

  console.log('Seed complete. Breakglass admin ensured: admin@example.com');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
