import cors from 'cors';
import express from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/me', async (_req, res, next) => {
  try {
    const demoUser = await prisma.user.findUnique({
      where: { email: 'admin@example.com' }
    });

    if (!demoUser) {
      return res.status(404).json({ message: 'Demo user not found' });
    }

    return res.status(200).json(demoUser);
  } catch (error) {
    return next(error);
  }
});

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ message: 'Internal server error' });
});
