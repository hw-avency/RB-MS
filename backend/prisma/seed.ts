import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: { name: 'Demo Admin', role: 'ADMIN' },
    create: {
      email: 'admin@example.com',
      name: 'Demo Admin',
      role: 'ADMIN'
    }
  });
}

main()
  .catch((error) => {
    console.error('Seed failed', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
