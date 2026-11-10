export type Role = 'admin' | 'coach';

/** The authenticated principal attached to `req.user`. */
export interface AuthUser {
  id: string;
  /** The role this sign-in is using. Everything role-based follows it. */
  role: Role;
  /** Every role the person holds (coach, admin, or both). */
  roles?: Role[];
  name: string;
  email: string;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  /** The role in use (for a listed user: the one they last signed in as). */
  role: Role;
  roles: Role[];
  status: 'invited' | 'active' | 'disabled';
  lastLoginAt: Date | null;
  createdAt: Date;
}
