import { Redis } from '@upstash/redis';

export const config = {
  api: {
    bodyParser: true,
  },
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  // CORS Configuration Allowances
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Auth'); // Added custom header validation
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 1. CHAT MESSAGE DISPATCH ROUTE
    if (req.method === 'POST') {
      const { sender, text, roomId } = req.body;
      if (!sender || !text) return res.status(400).json({ error: 'Missing fields' });
      
      const targetRoom = roomId ? `chat:messages:${roomId}` : 'chat:messages';
      const newMessage = { sender, text, timestamp: Date.now() };
      
      await redis.rpush(targetRoom, JSON.stringify(newMessage));
      await redis.ltrim(targetRoom, -200, -1); 
      return res.status(200).json({ success: true });
    }

    // 2. CHAT DATA RETRIEVAL ROUTE
    if (req.method === 'GET') {
      const { roomId } = req.query;
      const targetRoom = roomId ? `chat:messages:${roomId}` : 'chat:messages';
      
      const messages = await redis.lrange(targetRoom, 0, -1);
      return res.status(200).json(messages); 
    }

    // 3. ENFORCED ADMIN-ONLY DELETION ROUTE
    if (req.method === 'PATCH') {
      // SECURITY CHECK: Verify secret header before letting the database touch deletion actions
      const adminAuthHeader = req.headers['x-admin-auth'];
      if (adminAuthHeader !== 'Mityana9') {
        return res.status(403).json({ error: 'Unauthorized: Deletion restricted to Admin Panel only.' });
      }

      const { index, roomId } = req.body;
      if (index === undefined) return res.status(400).json({ error: 'Missing index' });

      const targetRoom = roomId ? `chat:messages:${roomId}` : 'chat:messages';
      const messages = await redis.lrange(targetRoom, 0, -1);
      if (index < 0 || index >= messages.length) return res.status(400).json({ error: 'Invalid index' });

      const targetMessageString = messages[index];
      
      // Safe list item match deletion 
      await redis.lrem(targetRoom, 1, targetMessageString);
      return res.status(200).json({ success: true });
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Database error' });
  }
}