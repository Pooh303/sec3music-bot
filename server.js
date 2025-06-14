require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { DisTube } = require('distube');
const { YtDlpPlugin } = require('@distube/yt-dlp');
const { YouTube } = require('youtube-sr');
const rateLimit = require('express-rate-limit');

const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const activeSessions = new Map();
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_TOKEN_EXPIRY_MS = ONE_DAY_MS;
const connectedUsers = new Map();
const userLastDmMap = new Map();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
});

const distube = new DisTube(client, {
    emitNewSongOnly: true,
    emitAddSongWhenCreatingQueue: false,
    plugins: [
        new YtDlpPlugin({ update: true })
    ]
});

const apiLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 100,
	standardHeaders: true,
	legacyHeaders: false,
    message: { error: 'Too many requests from this IP, please try again after 15 minutes' },
    keyGenerator: (req, res) => {
        return req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    }
});

app.use('/api/', apiLimiter);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function formatDuration(s) {
    if (isNaN(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const rs = Math.floor(s % 60);
    return `${m}:${rs.toString().padStart(2, '0')}`;
}

async function broadcastQueueUpdate(guildId, overrides = {}) {
    if (!guildId) return;
    const queue = distube.getQueue(guildId);
    
    let queueData;
    if (!queue || queue.songs.length === 0) {
        queueData = { current: null, queue: [] };
    } else {
        const currentSongData = queue.songs[0] ? {
            id: queue.songs[0].id,
            name: queue.songs[0].name,
            duration: queue.songs[0].duration,
            formattedDuration: queue.songs[0].formattedDuration,
            url: queue.songs[0].url,
            thumbnail: queue.songs[0].thumbnail,
            paused: queue.paused,
            currentTime: queue.currentTime,
            metadata: queue.songs[0].metadata,
            isLive: !!queue.songs[0].isLive,
            ...overrides 
        } : null;

        const upcomingSongs = queue.songs.slice(1).map(song => ({
            id: song.id,
            name: song.name,
            duration: song.duration,
            formattedDuration: song.formattedDuration,
            url: song.url,
            thumbnail: song.thumbnail,
            metadata: song.metadata,
            isLive: !!song.isLive
        }));
        
        queueData = { current: currentSongData, queue: upcomingSongs };
    }
    
    io.emit('queue-updated', queueData);
}

distube.on('playSong', (queue, song) => {
    broadcastQueueUpdate(queue.id);
    const addedBy = song.metadata?.addedBy;
    console.log(`Playing ${song.name} - ${song.formattedDuration}${addedBy ? ` (Added by: ${addedBy.name})` : ''}`);
    const messageChannel = queue.textChannel;
    if (messageChannel) {
        messageChannel.send(`▶️ กำลังเล่น: **${song.name}** - \`${song.formattedDuration}\`${addedBy ? ` (เพิ่มโดย: ${addedBy.name})` : ''}`).catch(console.error);
    }
});

distube.on('addSong', (queue, song) => {
    broadcastQueueUpdate(queue.id);
    const addedBy = song.metadata?.addedBy;
    console.log(`Added ${song.name} to queue${addedBy ? ` (Added by: ${addedBy.name})` : ''}`);
    const messageChannel = queue.textChannel;
    if (messageChannel) {
        messageChannel.send(`👍 เพิ่มเข้าคิว: **${song.name}** - \`${song.formattedDuration}\`${addedBy ? ` (เพิ่มโดย: ${addedBy.name})` : ''}`).catch(console.error);
    }
});

distube.on('finish', (queue) => {
    io.emit('queue-updated', { current: null, queue: [] });
    
    console.log('คิวเพลงจบแล้วจ้า');
    const messageChannel = queue.textChannel;
    if (messageChannel) {
        messageChannel.send('✅ คิวเพลงเล่นหมดแล้ว!').catch(console.error);
    }
});

distube.on('error', (channel, error) => {
    console.error('DisTube error:', error.message, error);
    const textChannel = channel.textChannel || (channel.type === 'GUILD_TEXT' ? channel : null);
    if (textChannel && typeof textChannel.send === 'function') {
        textChannel.send(`โอ๊ะ! เกิดข้อผิดพลาดกับระบบเพลง: ${String(error.message || error).slice(0, 1900)}`).catch(console.error);
    }
});

distube.on('finishSong', (queue, song) => {
    console.log(`[DisTube Event] จบเพลง ${song.name} แล้ว`);
});

const BOT_COMMAND_PREFIX = '!';
const PORT_FOR_URL = process.env.PORT || 3000;
const WEB_UI_BASE_URL = process.env.WEB_UI_URL || `http://localhost:${PORT_FOR_URL}`;

client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;
    if (!message.content.startsWith(BOT_COMMAND_PREFIX)) return;
    const args = message.content.slice(BOT_COMMAND_PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'music') {
        try {
            const lastDmId = userLastDmMap.get(message.author.id);
            if (lastDmId) {
                try {
                    const dmChannel = await message.author.createDM();
                    const oldDmMessage = await dmChannel.messages.fetch(lastDmId).catch(() => null);
                    if (oldDmMessage) await oldDmMessage.delete();
                } catch (deleteError) {
                    console.warn(`ไม่สามารถลบ DM เก่าของ ${message.author.username} ได้:`, deleteError.message);
                }
                userLastDmMap.delete(message.author.id);
            }
            const token = crypto.randomBytes(16).toString('hex');
            const userDetails = {
                userId: message.author.id,
                userName: message.author.username,
                userAvatar: message.author.displayAvatarURL({ dynamic: true, format: 'png', size: 64 }),
                timestamp: Date.now()
            };
            activeSessions.set(token, userDetails);
            setTimeout(() => {
                if (activeSessions.has(token)) {
                    activeSessions.delete(token);
                    console.log(`เซสชั่นของนาย ${userDetails.userName} หมดอายุแล้ว (หลัง 1 วัน)`);
                }
            }, SESSION_TOKEN_EXPIRY_MS);
            const sessionLink = `${WEB_UI_BASE_URL}?session_token=${token}`;
            const dmMessageContent = `*จัดไปวัยรุ่น ! ลิงก์ลับสำหรับเปิดเพลงของนายมาแล้ว : *\n||${sessionLink}||\n\n` +
                                   `👉  ลิงก์มีอายุ ${SESSION_TOKEN_EXPIRY_MS / (60 * 60 * 1000)} ชั่วโมง ถ้าใช้ไม่ได้แล้วก็พิมพ์คำสั่งใหม่ได้เลยน้ะ  😗`; 
            const sentDm = await message.author.send(dmMessageContent);
            if (sentDm) userLastDmMap.set(message.author.id, sentDm.id);
            await message.reply({ content: `${message.author}  แอบส่งลิงก์เปิดเพลงไปให้ใน DM แล้วนะ  😉` }).catch(console.error);
        } catch (error) {
            console.error('เกิดข้อผิดพลาดตอนส่ง DM คำสั่ง !music:', error);
            if (error.code === 50007) { 
                 message.reply({ content: `${message.author} อ๊ะ! เหมือนนายจะปิด DM ไว้นะ เปิดก่อนเร๊ว เดี๋ยวส่งลิงก์เพลงให้ไม่ได้ 😥` }).catch(console.error);
            } else {
                 message.reply({ content: `อุ๊ปส์! ${message.author} เหมือนจะมีอะไรผิดพลาดนิดหน่อย ลองใหม่อีกทีนะ 😅` }).catch(console.error);
            }
        }
    }
});

// --- API Endpoints ---
app.get('/api/user-info', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Session token is required' });
    const sessionData = activeSessions.get(token);
    if (!sessionData) return res.status(401).json({ error: 'Invalid or expired session token' });
    res.json({ userId: sessionData.userId, userName: sessionData.userName, userAvatar: sessionData.userAvatar });
});

app.post('/api/play', async (req, res) => {
    try {
        const { url, userId } = req.body;
        if (!url || !userId) return res.status(400).json({ error: 'URL and User ID are required' });
        
        const voiceChannel = await client.channels.fetch(process.env.VOICE_CHANNEL_ID).catch(() => null);
        if (!voiceChannel || !voiceChannel.isVoiceBased()) return res.status(404).json({ error: 'Configured voice channel not found or is not a voice channel.' });
        if (!voiceChannel.joinable) return res.status(403).json({ error: 'Bot does not have permission to join the voice channel.' });

        let addedByUserInfo = { id: userId, name: 'Unknown User', avatar: null };
        try { 
            const discordUser = await client.users.fetch(userId); 
            addedByUserInfo = { id: discordUser.id, name: discordUser.username, avatar: discordUser.displayAvatarURL({ dynamic: true, format: 'png', size: 32 })};
        } catch (fetchError) { 
            console.warn(`Could not fetch user details for ${userId}:`, fetchError.message); 
        }
        
        const textChannelForMessages = await client.channels.fetch(process.env.TEXT_CHANNEL_ID_FOR_BOT_MESSAGES).catch(() => null);
        await distube.play(voiceChannel, url, { textChannel: textChannelForMessages, metadata: { addedBy: addedByUserInfo } });
        res.json({ message: 'ได้รับคำขอแล้ว กำลังเล่น/เพิ่มเข้าคิว...' });
    } catch (error) { 
        console.error('Play API error:', error); 
        res.status(500).json({ error: error.message || 'Failed to process play request' }); 
    }
});

app.get('/api/queue', async (req, res) => {
    try {
        const voiceChannel = await client.channels.fetch(process.env.VOICE_CHANNEL_ID).catch(() => null);
        if (!voiceChannel || !voiceChannel.guild) return res.json({ current: null, queue: [] });
        
        const queue = distube.getQueue(voiceChannel.guild.id);
        if (!queue) return res.json({ current: null, queue: [] });
        
        const currentSong = queue.songs[0] ? { 
            id: queue.songs[0].id, 
            name: queue.songs[0].name, 
            duration: queue.songs[0].duration, 
            formattedDuration: queue.songs[0].formattedDuration, 
            url: queue.songs[0].url, 
            thumbnail: queue.songs[0].thumbnail, 
            paused: queue.paused, 
            currentTime: queue.currentTime, 
            metadata: queue.songs[0].metadata, 
            isLive: !!queue.songs[0].isLive 
        } : null;
        
        const upcomingSongs = queue.songs.slice(1).map(song => ({ 
            id: song.id, 
            name: song.name, 
            duration: song.duration, 
            formattedDuration: song.formattedDuration, 
            url: song.url, 
            thumbnail: song.thumbnail, 
            metadata: song.metadata, 
            isLive: !!song.isLive 
        }));
        
        res.json({ current: currentSong, queue: upcomingSongs });
    } catch (error) { 
        console.error('Queue API error:', error); 
        res.status(500).json({ error: error.message }); 
    }
});

async function getQueueFromEnv(res) {
    const voiceChannelId = process.env.VOICE_CHANNEL_ID;
    if (!voiceChannelId) {
        if (res) res.status(500).json({ error: 'VOICE_CHANNEL_ID is not configured in .env' });
        return null;
    }
    const voiceChannel = await client.channels.fetch(voiceChannelId).catch(() => null);
    if (!voiceChannel || !voiceChannel.guild) { 
        if (res) res.status(404).json({ error: 'Configured voice channel not found.' }); 
        return null; 
    }
    const queue = distube.getQueue(voiceChannel.guild.id);
    if (!queue) { 
        if (res) res.status(404).json({ error: 'No active queue.' }); 
        return null; 
    }
    return queue;
}

app.post('/api/reorder-queue', async (req, res) => {
    try {
        const { oldIndex, newIndex } = req.body;
        if (typeof oldIndex !== 'number' || typeof newIndex !== 'number') {
            return res.status(400).json({ error: 'Valid oldIndex and newIndex are required.' });
        }
        
        const queue = await getQueueFromEnv(res);
        if (!queue) return;

        const actualOldIndex = oldIndex + 1;
        const actualNewIndex = newIndex + 1;

        if (actualOldIndex < 1 || actualOldIndex >= queue.songs.length) {
            return res.status(400).json({ error: `Source index (${oldIndex}) is out of bounds.` });
        }
        
        const [songToMove] = queue.songs.splice(actualOldIndex, 1);
        if (!songToMove) {
            return res.status(404).json({ error: 'Song to move not found at the specified index.' });
        }

        queue.songs.splice(actualNewIndex, 0, songToMove);

        broadcastQueueUpdate(queue.id);
        res.json({ success: true, message: 'Queue reordered successfully.' });

    } catch (error) {
        console.error('[API REORDER] Error:', error);
        res.status(500).json({ error: error.message || 'Failed to reorder queue.' });
    }
});

app.post('/api/seek', async (req, res) => {
    try {
        const { time } = req.body;
        if (typeof time !== 'number') {
            return res.status(400).json({ error: 'Time (in seconds) is required and must be a number.' });
        }
        
        const queue = await getQueueFromEnv(res); 
        if (!queue) return;

        if (!queue.songs || queue.songs.length === 0) {
            return res.status(400).json({ error: 'No song currently playing to seek.' });
        }
        const currentSong = queue.songs[0];
        if (currentSong.isLive) { 
            return res.status(400).json({ error: 'Cannot seek a live stream.' });
        }
        
        const clampedTime = Math.max(0, Math.min(time, currentSong.duration)); 
        await queue.seek(clampedTime);
        broadcastQueueUpdate(queue.id, { currentTime: clampedTime });
        res.json({ 
            message: `Seeked to ${formatDuration(clampedTime)}`,
            requestedSeekTime: clampedTime 
        });
    } catch (error) {
        console.error('[API SEEK] Error:', error);
        res.status(500).json({ error: error.message || 'Failed to seek song.' });
    }
});

app.post('/api/stop', async (req, res) => {
    try {
        const q = await getQueueFromEnv(res);
        if (!q) return;
        await q.stop();
        
        io.emit('queue-updated', { current: null, queue: [] });
        
        res.json({ message: 'Stopped playback and cleared the queue.' });
    } catch (e) {
        console.error('Stop API error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/skip', async (req, res) => {
    try {
        const q = await getQueueFromEnv(res);
        if (!q) return;
        if (q.songs.length <= 1 && !q.autoplay) {
            await q.stop();
            return res.json({ message: 'Skipped and stopped (last song).' });
        }
        await q.skip();
        res.json({ message: 'Skipped the current song.' });
    } catch (e) {
        if (e.message.includes("No song to skip")) {
             return res.status(400).json({ error: "No next song to skip to." });
        }
        console.error('Skip API error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/volume', async (req, res) => {
    try {
        const { volume } = req.body;
        if (typeof volume !== 'number' || volume < 0 || volume > 200) {
            return res.status(400).json({ error: 'Volume must be a number between 0 and 200.' });
        }
        const q = await getQueueFromEnv(res);
        if (!q) return;
        q.setVolume(volume);
        res.json({ message: `Volume set to ${volume}%.` });
    } catch (e) {
        console.error('Volume API error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/pause', async (req, res) => {
    try {
        const q = await getQueueFromEnv(res);
        if (!q) return;
        if (q.paused) return res.status(400).json({ error: 'The music is already paused.' });
        q.pause();
        broadcastQueueUpdate(q.id, { paused: true });
        res.json({ message: 'Paused the music.' });
    } catch (e) {
        console.error('Pause API error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/resume', async (req, res) => {
    try {
        const q = await getQueueFromEnv(res);
        if (!q) return;
        if (!q.paused) return res.status(400).json({ error: 'The music is already playing.' });
        q.resume();
        broadcastQueueUpdate(q.id, { paused: false });
        res.json({ message: 'Resumed the music.' });
    } catch (e) {
        console.error('Resume API error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ error: 'Search query (q) is required.' });
        const results = await YouTube.search(q, { limit: 10, type: 'video', safeSearch: true });
        const items = results.map(video => ({ id: { videoId: video.id }, snippet: { title: video.title || 'Untitled Video', channelTitle: video.channel ? video.channel.name : 'Unknown Channel', thumbnails: { medium: { url: video.thumbnail ? video.thumbnail.url : 'https://via.placeholder.com/120x68?text=No+Thumb' } } } }));
        res.json({ items });
    } catch (e) {
        console.error('Search API error:', e);
        res.status(500).json({ error: e.message || 'An unknown error occurred.' });
    }
});

app.post('/api/remove', async (req, res) => {
    try {
        const { index } = req.body;
        if (typeof index !== 'number' || index < 0) {
            return res.status(400).json({ error: 'A valid song index is required.' });
        }
        const q = await getQueueFromEnv(res);
        if (!q) return;
        if (index >= q.songs.length - 1) {
            return res.status(400).json({ error: 'Index is out of bounds for the queue.' });
        }
        const removed = q.songs.splice(index + 1, 1)[0];
        broadcastQueueUpdate(q.id);
        res.json({ success: true, message: `Removed "${removed.name}" from the queue.` });
    } catch (e) {
        console.error('Remove API error:', e);
        res.status(500).json({ error: 'Failed to remove the song.' });
    }
});

// --- Socket.IO ---
io.on('connection', (socket) => {
    socket.on('identify', (token) => {
        const sessionData = activeSessions.get(token);
        if (sessionData) {
            const userDetails = { userId: sessionData.userId, userName: sessionData.userName, userAvatar: sessionData.userAvatar };
            connectedUsers.set(socket.id, userDetails);
            socket.emit('current-users', Array.from(connectedUsers.values()));
            socket.broadcast.emit('user-joined', userDetails);
        }
    });
    socket.on('disconnect', () => {
        const userDetails = connectedUsers.get(socket.id);
        if (userDetails) {
            connectedUsers.delete(socket.id);
            io.emit('user-left', userDetails.userId);
        }
    });
});

// --- Server Setup ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use((err, req, res, next) => { 
    console.error('Server error stack:', err.stack); 
    res.status(500).json({ error: err.message || 'Internal server error' }); 
});

const portToListen = process.env.PORT || 3000;
httpServer.listen(portToListen, () => {
    console.log(`Server running on port ${portToListen}`);
    console.log(`Web UI available at ${WEB_UI_BASE_URL}/`);
});

client.login(process.env.DISCORD_TOKEN).catch(error => { 
    console.error('Discord login error:', error); 
    process.exit(1); 
});

setInterval(() => {
    const now = Date.now();
    for (const [token, session] of activeSessions.entries()) {
        if (now - session.timestamp > SESSION_TOKEN_EXPIRY_MS) { 
            activeSessions.delete(token);
            console.log(`Session token for ${session.userName} auto-cleaned.`);
        }
    }
}, 60 * 60 * 1000);