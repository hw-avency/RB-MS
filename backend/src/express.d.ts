export {};

declare global {
  namespace Express {
    interface UserContext {
      employeeId: string;
      email: string;
      displayName: string;
      isAdmin: boolean;
      authProvider: 'breakglass' | 'entra';
      isActive: boolean;
      created: boolean;
      photoBase64: string | null;
    }

    interface Request {
      user?: UserContext;
    }
  }
}
