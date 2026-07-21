import { Redis } from '@upstash/redis';

export const config = { api: { bodyParser: true } };
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// Enforces exact capitalization matching (e.g., User_14 or User_1089) to map to chat:room:User_... keys
function getExactCaseId(roomId) {
  if (!roomId) return "";
  // Strip prefixes and normalize format with a capital 'User_'
  let cleanId = roomId.replace('chat:room:', '').replace('chat:unread:', '').trim();
  if (cleanId.toLowerCase().startsWith('user_')) {
    return 'User_' + cleanId.substring(5);
  } else if (cleanId.toLowerCase().startsWith('user')) {
    return 'User_' + cleanId.substring(4);
  }
  return cleanId; // Fallback for mixed tokens like CVBT6PD
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

      const cleanId = getExactCaseId(roomId);
      await redis.del(`chat:room:${cleanId}`);
      await redis.del(`chat:unread:${cleanId}`);
      await redis.hdel('chat:active_rooms', cleanId);
      return res.status(200).json({ success: true });
    }

    // 2. FIRST VISIT WIDGET HANDSHAKE
    if (req.method === 'GET' && req.query.action === 'get_id') {
      const { roomId } = req.query;
      if (!roomId || roomId === 'null' || roomId === 'undefined') return res.status(400).json({ error: 'Invalid roomId' });
      
      const cleanId = getExactCaseId(roomId);
      const roomExists = await redis.hexists('chat:active_rooms', cleanId);
      if (!roomExists) {
        await redis.hset('chat:active_rooms', { [cleanId]: Date.now() });
      }
      return res.status(200).json({ roomId: cleanId });
    }

    // 3. POST A NEW MESSAGE
    if (req.method === 'POST') {
      const { sender, text, roomId } = req.body;
      if (!sender || !text || !roomId || roomId === 'null' || roomId === 'undefined') {
        return res.status(400).json({ error: 'Missing or invalid fields' });
      }
      
      const cleanId = getExactCaseId(roomId); 
      const newMessage = { sender, text, timestamp: Date.now() };
      
      await redis.rpush(`chat:room:${cleanId}`, JSON.stringify(newMessage));
      await redis.ltrim(`chat:room:${cleanId}`, -1000, -1);
      await redis.hset('chat:active_rooms', { [cleanId]: Date.now() });

      if (sender === 'user') {
        await redis.hincrby(`chat:unread:${cleanId}`, 'admin', 1);
      } else if (sender === 'admin') {
        await redis.hincrby(`chat:unread:${cleanId}`, 'user', 1);
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
          if (!id || id === 'null' || id === 'undefined' || id.trim() === '') continue;
          
          const cleanId = getExactCaseId(id);
          const unread = await redis.hgetall(`chat:unread:${cleanId}`) || {};
          
          // Formats case-sensitive string into dashboard label "User #14"
          let displayLabel = cleanId.replace('User_', 'User #');
          
          list.push({ 
            id: cleanId, 
            lastActive: rooms[id], 
            adminUnread: parseInt(unread.admin || 0),
            displayName: displayLabel
          });
        }
        return res.status(200).json(list);
      }

      if (!roomId || roomId === 'null' || roomId === 'undefined') return res.status(400).json({ error: 'Invalid roomId' });
      const cleanId = getExactCaseId(roomId);
      
      const messagesRaw = await redis.lrange(`chat:room:${cleanId}`, 0, -1) || [];
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
      const cleanId = getExactCaseId(roomId);
      await redis.hset(`chat:unread:${cleanId}`, { [clearFor]: 0 });
      return res.status(200).json({ success: true });
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({ error: 'Database error' });
  }
}