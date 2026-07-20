import { Redis } from '@upstash/redis';

export const config = { api: { bodyParser: true } };
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Auth');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 1. SEND A MESSAGE
    if (req.method === 'POST') {
      const { sender, text, roomId } = req.body;
      if (!sender || !text || !roomId) return res.status(400).json({ error: 'Missing fields' });
      
      const newMessage = { sender, text, timestamp: Date.now() };
      
      // Save message to this specific room's history
      await redis.rpush(`chat:room:${roomId}`, JSON.stringify(newMessage));
      await redis.ltrim(`chat:room:${roomId}`, -200, -1);

      // Track this room in the global active rooms list for the admin
      await redis.hset('chat:active_rooms', { [roomId]: Date.now() });

      // Update Unread Counters
      if (sender === 'user') {
        // Increment unread count for admin to see
        await redis.hincrby(`chat:unread:${roomId}`, 'admin', 1);
      } else if (sender === 'admin') {
        // Increment unread count for user to see
        await redis.hincrby(`chat:unread:${roomId}`, 'user', 1);
      }

      return res.status(200).json({ success: true });
    }

    // 2. GET MESSAGES OR ACTIVE ROOMS LIST
    if (req.method === 'GET') {
      const { roomId, type } = req.query;

      // Admin requesting the list of all active chat rooms + unread counts
      if (type === 'list') {
        const rooms = await redis.hgetall('chat:active_rooms') || {};
        const list = [];
        for (const id of Object.keys(rooms)) {
          const unread = await redis.hgetall(`chat:unread:${id}`) || {};
          list.push({ id, lastActive: rooms[id], adminUnread: parseInt(unread.admin || 0) });
        }
        return res.status(200).json(list);
      }

      // Fetching message history for a specific room
      if (!roomId) return res.status(400).json({ error: 'Missing roomId' });
      const messages = await redis.lrange(`chat:room:${roomId}`, 0, -1);
      
      // Fetch user unread count for the widget button badge
      const unread = await redis.hgetall(`chat:unread:${roomId}`) || {};

      return res.status(200).json({ messages, userUnread: parseInt(unread.user || 0) });
    }

    // 3. CLEAR UNREAD BADGES WHEN OPENED
    if (req.method === 'PATCH') {
      const { roomId, clearFor } = req.body;
      if (!roomId || !clearFor) return res.status(400).json({ error: 'Missing parameters' });

      // Clear the specific badge count to 0
      await redis.hset(`chat:unread:${roomId}`, { [clearFor]: 0 });
      return res.status(200).json({ success: true });
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Database error' });
  }
}