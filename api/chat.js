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
  // ADD THIS: Allow your website to call this API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'POST') {
      const { sender, text } = req.body;
      if (!sender || !text) return res.status(400).json({ error: 'Missing fields' });
      
      const newMessage = { sender, text, timestamp: Date.now() };
      await redis.rpush('chat:messages', JSON.stringify(newMessage));
      await redis.ltrim('chat:messages', -200, -1); // keep only last 200 messages
      return res.status(200).json({ success: true });
    }

    if (req.method === 'GET') {
      const messages = await redis.lrange('chat:messages', 0, -1);
      return res.status(200).json(messages); // array of JSON strings
    }

    if (req.method === 'PATCH') {
      const { index } = req.body;
      if (index === undefined) return res.status(400).json({ error: 'Missing index' });

      const messages = await redis.lrange('chat:messages', 0, -1);
      if (index < 0 || index >= messages.length) return res.status(400).json({ error: 'Invalid index' });

      messages.splice(index, 1); // remove 1 message
      await redis.del('chat:messages');
      if (messages.length > 0) {
        await redis.rpush('chat:messages', ...messages);
      }
      return res.status(200).json({ success: true });
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Database error' });
  }
}