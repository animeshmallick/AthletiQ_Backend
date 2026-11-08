export type Role = 'admin' | 'coach';

/** The authenticated principal attached to `req.user`. */
export interface AuthUser {
  id: string;
  role: Role;
  name: string;
  email: string;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: Role;
  status: 'invited' | 'active' | 'disabled';
  lastLoginAt: Date | null;
  createdAt: Date;
}
