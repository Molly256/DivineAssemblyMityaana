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
    // NEW ROUTE: GENERATE PERMANENT INCREMENTAL USER ID FOR NEW VISITORS
    if (req.method === 'GET' && req.query.action === 'get_id') {
      // Increments chat:user_counter automatically (starts at 1 up to 10000+)
      const nextIdNumber = await redis.incr('chat:user_counter');
      const assignedId = `User_${nextIdNumber}`;
      return res.status(200).json({ roomId: assignedId });
    }

    // 1. SAVE INCOMING MESSAGES
    if (req.method === 'POST') {
      const { sender, text, roomId } = req.body;
      if (!sender || !text || !roomId) return res.status(400).json({ error: 'Missing fields' });
      
      const newMessage = { sender, text, timestamp: Date.now() };
      const targetRoom = `chat:room:${roomId}`;
      
      // Save message securely to Redis
      await redis.rpush(targetRoom, JSON.stringify(newMessage));
      
      // Increased from 200 to 1000 messages to prevent automatic deletion history cuts!
      await redis.ltrim(targetRoom, -1000, -1); 

      // Track active channels list for admin dashboard sidebar
      await redis.hset('chat:active_rooms', { [roomId]: Date.now() });

      if (sender === 'user') {
        await redis.hincrby(`chat:unread:${roomId}`, 'admin', 1);
      } else if (sender === 'admin') {
        await redis.hincrby(`chat:unread:${roomId}`, 'user', 1);
      }
      return res.status(200).json({ success: true });
    }

    // 2. GET CONVERSATION HISTORY OR SIDEBAR CHANNELS
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
      const messages = await redis.lrange(`chat:room:${roomId}`, 0, -1);
      const unread = await redis.hgetall(`chat:unread:${roomId}`) || {};

      return res.status(200).json({ 
        messages: messages, 
        userUnread: parseInt(unread.user || 0) 
      });
    }

    // 3. RESET UNREAD BADGES
    if (req.method === 'PATCH') {
      const { roomId, clearFor } = req.body;
      if (roomId && clearFor) {
        await redis.hset(`chat:unread:${roomId}`, { [clearFor]: 0 });
      }
      return res.status(200).json({ success: true });
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Database error' });
  }
}