/**
 * Auth helpers (use them only if the app needs accounts).
 *   hashPassword / checkPassword  - bcrypt
 *   signToken(user)               - JWT with { sub: user.id, email, role }
 *   requireAuth                   - 401 without a valid Bearer token; sets req.user = { id, email, role }
 *   requireRole('admin')          - use after requireAuth; 403 for other roles
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// Never fall back to a known secret: without JWT_SECRET, tokens are signed with a
// random per-process key (they stop working after a restart).
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.warn('JWT_SECRET is not set: using a random secret, sessions reset on restart');
}

export const hashPassword = (plain) => bcrypt.hash(plain, 10);
export const checkPassword = (plain, hash) => bcrypt.compare(plain, hash);

export function signToken(user) {
  return jwt.sign({ sub: String(user.id), email: user.email, role: user.role ?? 'user' }, SECRET, { expiresIn: '7d' });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, SECRET);
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export const requireRole = (role) => (req, res, next) =>
  req.user?.role === role ? next() : res.status(403).json({ error: 'Forbidden' });
