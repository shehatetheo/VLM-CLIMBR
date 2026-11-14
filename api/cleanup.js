// POST /api/cleanup {urls} — delete a run's playback copy and poster from Blob
// once the browser has its own copies. Only this project's media/ objects.
import { del } from '@vercel/blob'

const ours = (u) => {
  try {
    const { protocol, hostname, pathname } = new URL(u)
    return protocol === 'https:' && hostname.endsWith('.blob.vercel-storage.com') && pathname.startsWith('/media/')
  } catch {
    return false
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const urls = (Array.isArray(req.body?.urls) ? req.body.urls : []).filter(ours).slice(0, 6)
  if (urls.length && process.env.BLOB_READ_WRITE_TOKEN) await del(urls).catch(() => {})
  res.status(200).json({ deleted: urls.length })
}
