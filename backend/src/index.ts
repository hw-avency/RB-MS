import express from 'express';
import { prisma } from './prisma';

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok' });
  } catch {
    res.status(500).json({ status: 'error' });
  }
});

app.get('/me', (_req, res) => {
  res.status(200).json({
    id: 'demo-user',
    email: 'demo@example.com',
    displayName: 'Demo User',
    role: 'user'
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`API listening on ${port}`);
});
