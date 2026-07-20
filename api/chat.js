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
    // GENERATE UNIQUE INCREMENTAL SERIAL ID
    if (req.method === 'GET' && req.query.action === 'get_id') {
      const nextIdNumber = await redis.incr('chat:user_counter');
      return res.status(200).json({ roomId: `User_${nextIdNumber}` });
    }

    // 1. POST A NEW CHAT MESSAGE
    if (req.method === 'POST') {
      const { sender, text, roomId } = req.body;
      if (!sender || !text || !roomId) return res.status(400).json({ error: 'Missing fields' });
      
      const cleanRoomId = roomId.replace('chat:room:', ''); // Strip any redundant legacy wrappers
      const newMessage = { sender, text, timestamp: Date.now() };
      
      await redis.rpush(`chat:room:${cleanRoomId}`, JSON.stringify(newMessage));
      await redis.ltrim(`chat:room:${cleanRoomId}`, -1000, -1);
      await redis.hset('chat:active_rooms', { [cleanRoomId]: Date.now() });

      if (sender === 'user') {
        await redis.hincrby(`chat:unread:${cleanRoomId}`, 'admin', 1);
      } else if (sender === 'admin') {
        await redis.hincrby(`chat:unread:${cleanRoomId}`, 'user', 1);
      }
      return res.status(200).json({ success: true });
    }

    // 2. GET MESSAGES OR LIST ACTIVE ROOM CHANNELS
    if (req.method === 'GET') {
      const { roomId, type } = req.query;

      if (type === 'list') {
        const rooms = await redis.hgetall('chat:active_rooms') || {};
        const list = [];
        for (const id of Object.keys(rooms)) {
          const unread = await redis.hgetall(`chat:unread:${id}`) || {};
          list.push({ id, lastActive: rooms[id], adminUnread: parseInt(unread.admin || 0) });
        }
        return res.status(200).json(list);
      }

      if (!roomId) return res.status(400).json({ error: 'Missing roomId' });
      const cleanRoomId = roomId.replace('chat:room:', '');
      
      // Pull history from the explicit wrapper path
      const messages = await redis.lrange(`chat:room:${cleanRoomId}`, 0, -1);
      return res.status(200).json({ messages });
    }

    // 3. RESET BADGE METRICS
    if (req.method === 'PATCH') {
      const { roomId, clearFor } = req.body;
      if (roomId && clearFor) {
        const cleanRoomId = roomId.replace('chat:room:', '');
        await redis.hset(`chat:unread:${cleanRoomId}`, { [clearFor]: 0 });
      }
      return res.status(200).json({ success: true });
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({ error: 'Database error' });
  }
}