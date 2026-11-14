// POST /api/admin — the moderation queue. See server/admin.mjs.
import { admin } from '../server/admin.mjs'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const { status, json } = await admin(req.headers['x-admin-password'], req.body)
  res.status(status).json(json)
}
