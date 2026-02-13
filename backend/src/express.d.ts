export {};

declare global {
  namespace Express {
    interface UserContext {
      employeeId: string;
      email: string;
      displayName: string;
      isAdmin: boolean;
      authProvider: 'breakglass' | 'entra';
    }

    interface Request {
      user?: UserContext;
    }
  }
}
