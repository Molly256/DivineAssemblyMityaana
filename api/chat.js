import { Redis } from '@upstash/redis';

export const config = { api: { bodyParser: true } };
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

function generateUniqueUsername(roomId) {
  if (!roomId || roomId === 'null' || roomId === 'undefined') return "Anonymous Guest";
  const adjectives = ["Bright", "Noble", "Swift", "Calm", "Kind", "Brave", "Joyful", "Wise", "Active", "Graceful"];
  const nouns = ["Beacon", "Harbor", "Shield", "Eagle", "Falcon", "Cheetah", "River", "Haven", "Runner", "Dove"];
  
  let hash = 0;
  for (let i = 0; i < roomId.length; i++) {
    hash = roomId.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  const adjIndex = Math.abs(hash) % adjectives.length;
  const nounIndex = Math.abs(hash * 3) % nouns.length;
  
  return `${adjectives[adjIndex]} ${nouns[nounIndex]}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Auth');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 1. DELETE CONVERSATION
    if (req.method === 'DELETE') {
      const authHeader = req.headers['x-admin-auth'];
      if (authHeader !== 'Mityana9') return res.status(403).json({ error: 'Unauthorized' });

      const { roomId } = req.body;
      if (!roomId || roomId === 'null' || roomId === 'undefined') return res.status(400).json({ error: 'Invalid roomId' });

      const cleanId = roomId.replace('chat:room:', '');
      await redis.del(`chat:room:${cleanId}`);
      await redis.del(`chat:unread:${cleanId}`);
      await redis.hdel('chat:active_rooms', cleanId);
      return res.status(200).json({ success: true });
    }

    // 2. FIRST VISIT WIDGET HANDSHAKE
    if (req.method === 'GET' && req.query.action === 'get_id') {
      const { roomId } = req.query;
      if (!roomId || roomId === 'null' || roomId === 'undefined') return res.status(400).json({ error: 'Invalid roomId' });
      
      const cleanRoomId = roomId.replace('chat:room:', '');
      const roomExists = await redis.hexists('chat:active_rooms', cleanRoomId);
      if (!roomExists) {
        await redis.hset('chat:active_rooms', { [cleanRoomId]: Date.now() });
      }
      return res.status(200).json({ roomId: cleanRoomId });
    }

    // 3. POST A NEW MESSAGE
    if (req.method === 'POST') {
      const { sender, text, roomId } = req.body;
      if (!sender || !text || !roomId || roomId === 'null' || roomId === 'undefined') {
        return res.status(400).json({ error: 'Missing or invalid fields' });
      }
      
      const cleanRoomId = roomId.replace('chat:room:', ''); 
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

    // 4. GET MESSAGES OR LIST ROOMS
    if (req.method === 'GET') {
      const { roomId, type } = req.query;

      if (type === 'list') {
        const rooms = await redis.hgetall('chat:active_rooms') || {};
        const list = [];
        for (const id of Object.keys(rooms)) {
          // Guard block: ignore broken null or undefined keys stored historically
          if (!id || id === 'null' || id === 'undefined' || id.trim() === '') continue;
          
          const unread = await redis.hgetall(`chat:unread:${id}`) || {};
          list.push({ 
            id: id, 
            lastActive: rooms[id], 
            adminUnread: parseInt(unread.admin || 0),
            displayName: generateUniqueUsername(id)
          });
        }
        return res.status(200).json(list);
      }

      if (!roomId || roomId === 'null' || roomId === 'undefined') return res.status(400).json({ error: 'Invalid roomId' });
      const cleanRoomId = roomId.replace('chat:room:', '');
      
      const messagesRaw = await redis.lrange(`chat:room:${cleanRoomId}`, 0, -1) || [];
      const messages = messagesRaw.map(msg => {
        if (typeof msg === 'string') {
          try { return JSON.parse(msg); } catch (e) { return { sender: 'user', text: msg, timestamp: Date.now() }; }
        }
        return msg;
      });
      return res.status(200).json({ messages });
    }

    // 5. RESET BADGE METRICS
    if (req.method === 'PATCH') {
      const { roomId, clearFor } = req.body;
      if (!roomId || roomId === 'null' || roomId === 'undefined' || !clearFor) {
        return res.status(400).json({ error: 'Invalid payload elements' });
      }
      const cleanRoomId = roomId.replace('chat:room:', '');
      await redis.hset(`chat:unread:${cleanRoomId}`, { [clearFor]: 0 });
      return res.status(200).json({ success: true });
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({ error: 'Database error' });
  }
}