require('dotenv').config();
const express = require('express');
// ***** เอา EmbedBuilder ออกจากการ import *****
const { Client, GatewayIntentBits, Partials } = require('discord.js'); 
const { DisTube } = require('distube');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();

// --- Session Management ---
const activeSessions = new Map();
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_TOKEN_EXPIRY_MS = ONE_DAY_MS;

// --- Store Last DM Message ID for each user ---
const userLastDmMap = new Map();

// Discord client setup
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

// DisTube setup
const distube = new DisTube(client, {
    searchSongs: 0,
    searchCooldown: 30,
    leaveOnEmpty: false,
    leaveOnFinish: false,
    leaveOnStop: false,
    emitNewSongOnly: true,
    emitAddSongWhenCreatingQueue: false,
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'client')));

// --- Function to format duration (used in multiple places) ---
function formatDuration(s) {
    if (isNaN(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const rs = Math.floor(s % 60);
    return `${m}:${rs.toString().padStart(2, '0')}`;
}


// --- DisTube Event Handlers (Plain Text Messages) ---
distube.on('playSong', (queue, song) => {
    const addedBy = song.metadata?.addedBy;
    console.log(`Playing ${song.name} - ${song.formattedDuration}${addedBy ? ` (Added by: ${addedBy.name})` : ''}`);
    const messageChannel = queue.textChannel;
    if (messageChannel) {
        // ***** ใช้ข้อความธรรมดาตามที่คุณคอมเมนต์ไว้ *****
        messageChannel.send(`▶️ กำลังเล่น: **${song.name}** - \`${song.formattedDuration}\`${addedBy ? ` (เพิ่มโดย: ${addedBy.name})` : ''}`).catch(console.error);
    }
});

distube.on('addSong', (queue, song) => {
    const addedBy = song.metadata?.addedBy;
    console.log(`Added ${song.name} to queue${addedBy ? ` (Added by: ${addedBy.name})` : ''}`);
    const messageChannel = queue.textChannel;
    if (messageChannel) {
        // ***** ใช้ข้อความธรรมดาตามที่คุณคอมเมนต์ไว้ *****
        messageChannel.send(`👍 เพิ่มเข้าคิว: **${song.name}** - \`${song.formattedDuration}\`${addedBy ? ` (เพิ่มโดย: ${addedBy.name})` : ''}`).catch(console.error);
    }
});

distube.on('finish', (queue) => {
    console.log('คิวเพลงจบแล้วจ้า');
    const messageChannel = queue.textChannel;
    if (messageChannel) {
        // ***** ใช้ข้อความธรรมดาตามที่คุณคอมเมนต์ไว้ *****
        messageChannel.send('✅ คิวเพลงเล่นหมดแล้ว!').catch(console.error);
    }
});

distube.on('error', (channel, error) => {
    console.error('DisTube error:', error.message, error); // Log the full error object too
    // ***** ใช้ข้อความธรรมดาตามที่คุณคอมเมนต์ไว้ *****
    if (channel && typeof channel.send === 'function') {
        channel.send(`โอ๊ะ! เกิดข้อผิดพลาดกับระบบเพลง: ${String(error.message || error).slice(0, 1900)}`).catch(console.error);
    } else if (error.textChannel && typeof error.textChannel.send === 'function') {
        error.textChannel.send(`โอ๊ะ! เกิดข้อผิดพลาดกับระบบเพลง: ${String(error.message || error).slice(0, 1900)}`).catch(console.error);
    }
});

distube.on('finishSong', (queue, song) => {
    console.log(`[DisTube Event] จบเพลง ${song.name} แล้ว`);
    console.log(`[DisTube Event] เพลงที่เหลือในคิว (หลัง finishSong ของ ${song.name}): ${queue.songs.map(s => s.name).join(', ')}`);
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
                    if (oldDmMessage) {
                        await oldDmMessage.delete();
                        console.log(`ลบ DM เก่า (ID: ${lastDmId}) ของ ${message.author.username} แล้ว`);
                    }
                } catch (deleteError) {
                    console.warn(`ไม่สามารถลบ DM เก่าของ ${message.author.username} ได้ (อาจจะถูกลบไปแล้ว):`, deleteError.message);
                }
                userLastDmMap.delete(message.author.id);
            }

            const token = crypto.randomBytes(16).toString('hex');
            const userDetails = {
                userId: message.author.id,
                userName: message.author.username,
                userAvatar: message.author.displayAvatarURL({ dynamic: true, format: 'png', size: 64 }),
                timestamp: Date.now(),
            };
            activeSessions.set(token, userDetails);

            setTimeout(() => {
                if (activeSessions.has(token)) {
                    activeSessions.delete(token);
                    console.log(`เซสชั่นของนาย ${userDetails.userName} หมดอายุแล้วล่ะ 🥹 (หลัง 1 วัน)`);
                }
            }, SESSION_TOKEN_EXPIRY_MS);

            const sessionLink = `${WEB_UI_BASE_URL}/index.html?session_token=${token}`;
            
            const dmMessageContent = `*จัดไปวัยรุ่น ! ลิงก์ลับสำหรับเปิดเพลงของนายมาแล้ว : *\n||${sessionLink}||\n\n` +
                                   `👉  ลิงก์มีอายุ ${SESSION_TOKEN_EXPIRY_MS / (60 * 60 * 1000)} ชั่วโมง ถ้าใช้ไม่ได้แล้วก็พิมพ์คำสั่งใหม่ได้เลยน้ะ  😗`; 
            
            const sentDm = await message.author.send(dmMessageContent);
            if (sentDm) {
                userLastDmMap.set(message.author.id, sentDm.id);
            }
            
            await message.reply({ 
                content: `${message.author}  แอบส่งลิงก์เปิดเพลงไปให้ใน DM แล้วนะ  😉`
            }).catch(console.error);

        } catch (error) {
            console.error('เกิดข้อผิดพลาดตอนส่ง DM คำสั่ง !music:', error);
            if (error.code === 50007) { 
                 message.reply({ 
                     content: `${message.author} อ๊ะ! เหมือนนายจะปิด DM ไว้นะ เปิดก่อนเร๊ว เดี๋ยวส่งลิงก์เพลงให้ไม่ได้ 😥 (ลองเช็คการตั้งค่า **Content & Social** -> **Social permissions** -> **Allow DMs from other server members**`
                 }).catch(console.error);
            } else {
                 message.reply({
                     content: `อุ๊ปส์! ${message.author} เหมือนจะมีอะไรผิดพลาดนิดหน่อย ลองใหม่อีกทีนะ 😅`
                 }).catch(console.error);
            }
        }
    }
});

// --- API Endpoints ---
app.get('/api/user-info', async (req, res) => {
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
        let addedByUserInfo = { id: userId, name: 'Unknown User', avatar: null };
        try { const discordUser = await client.users.fetch(userId); addedByUserInfo = { id: discordUser.id, name: discordUser.username, avatar: discordUser.displayAvatarURL({ dynamic: true, format: 'png', size: 32 })};
        } catch (fetchError) { console.warn(`Could not fetch user details for ${userId}:`, fetchError.message); }
        
        const designatedTextChannelId = process.env.TEXT_CHANNEL_ID_FOR_BOT_MESSAGES;
        let textChannelForMessages = null;
        if (designatedTextChannelId) {
            textChannelForMessages = await client.channels.fetch(designatedTextChannelId).catch(() => null);
            if (textChannelForMessages && textChannelForMessages.type !== 0) textChannelForMessages = null; 
        }
        if (!textChannelForMessages && voiceChannel.guild) { 
            textChannelForMessages = voiceChannel.guild.channels.cache.find(c => c.type === 0 && c.permissionsFor(client.user.id).has("SendMessages")) || 
                                  (voiceChannel.guild.systemChannel && voiceChannel.guild.systemChannel.permissionsFor(client.user.id).has("SendMessages") ? voiceChannel.guild.systemChannel : null);
        }
        if (!textChannelForMessages) console.warn("Could not find a suitable text channel for DisTube bot messages.");

        await distube.play(voiceChannel, url, { member: voiceChannel.guild.members.me, textChannel: textChannelForMessages, metadata: { addedBy: addedByUserInfo } });
        res.json({ message: 'ได้รับคำขอแล้ว กำลังเล่น/เพิ่มเข้าคิว...' });
    } catch (error) { console.error('Play API error:', error); res.status(500).json({ error: error.message || 'Failed to process play request' }); }
});

app.get('/api/queue', async (req, res) => {
    try {
        const voiceChannel = await client.channels.fetch(process.env.VOICE_CHANNEL_ID).catch(() => null);
        if (!voiceChannel || !voiceChannel.guild) return res.json({ current: null, queue: [] });
        const queue = distube.getQueue(voiceChannel.guild.id);
        if (!queue) return res.json({ current: null, queue: [] });
        // ***** ย้อนกลับไปใช้ข้อมูล duration และ formattedDuration จาก DisTube โดยตรง และเพิ่ม isLive *****
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
            isLive: typeof queue.songs[0].isLive === 'boolean' ? queue.songs[0].isLive : false // ส่ง isLive ไปให้ client
        } : null;
        
        const upcomingSongs = queue.songs.slice(1).map(song => ({ 
            id: song.id, 
            name: song.name, 
            duration: song.duration,
            formattedDuration: song.formattedDuration, 
            url: song.url, 
            thumbnail: song.thumbnail, 
            metadata: song.metadata,
            isLive: typeof song.isLive === 'boolean' ? song.isLive : false // ส่ง isLive ไปให้ client
        }));
        res.json({ current: currentSong, queue: upcomingSongs });
    } catch (error) { console.error('Queue API error:', error); res.status(500).json({ error: error.message }); }
});

async function getQueueFromEnv(res) {
    const voiceChannelId = process.env.VOICE_CHANNEL_ID;
    if (!voiceChannelId) {
        if (res) res.status(500).json({ error: 'VOICE_CHANNEL_ID is not configured in .env' });
        console.error('VOICE_CHANNEL_ID is not configured in .env');
        return null;
    }
    const voiceChannel = await client.channels.fetch(voiceChannelId).catch(() => null);
    if (!voiceChannel || !voiceChannel.guild) { 
        if (res) res.status(404).json({ error: 'Configured voice channel not found or no guild context.' }); 
        return null; 
    }
    const queue = distube.getQueue(voiceChannel.guild.id);
    if (!queue) { 
        if (res) res.status(404).json({ error: 'No active queue in this guild.' }); 
        return null; 
    }
    return queue;
}

app.post('/api/seek', async (req, res) => {
    try {
        const { time } = req.body; 
        console.log(`[API SEEK] Received seek request for time: ${time}`);

        if (typeof time !== 'number') {
            return res.status(400).json({ error: 'Time (in seconds) is required and must be a number.' });
        }

        const queue = await getQueueFromEnv(res); 
        if (!queue) return; 

        if (!queue.songs || queue.songs.length === 0 || !queue.songs[0]) {
            console.log('[API SEEK] No song currently playing.');
            return res.status(400).json({ error: 'No song currently playing to seek.' });
        }

        const currentSong = queue.songs[0];
        if (currentSong.isLive || currentSong.duration === 0) { 
            console.log('[API SEEK] Cannot seek live stream or song with zero duration.');
            return res.status(400).json({ error: 'Cannot seek a live stream or song with zero duration.' });
        }

        const currentSongDuration = currentSong.duration;
        const clampedTime = Math.max(0, Math.min(time, currentSongDuration - 1)); 

        console.log(`[API SEEK] Seeking song "${currentSong.name}" to: ${clampedTime} (Original request: ${time}, Duration: ${currentSongDuration})`);
        
        await queue.seek(clampedTime);
        
        res.json({ 
            message: `คำสั่งข้ามเพลงถูกส่งไปที่ ${formatDuration(clampedTime)} แล้ว`,
            requestedSeekTime: clampedTime 
        });

    } catch (error) {
        console.error('[API SEEK] Error:', error);
        res.status(500).json({ error: error.message || 'Failed to seek song.' });
    }
});

app.post('/api/reorder-queue', async (req, res) => {
    try {
        const { oldIndex, newIndex } = req.body;
        console.log("[API REORDER] Received reorder request:", { oldIndex, newIndex });

        if (typeof oldIndex !== 'number' || typeof newIndex !== 'number' || oldIndex < 0 || newIndex < 0) {
            return res.status(400).json({ error: 'Valid oldIndex and newIndex are required.' });
        }

        const queue = await getQueueFromEnv(res); 
        if (!queue) return; 

        const actualOldIdxInDisTubeSongs = oldIndex + 1;
        const actualNewIdxInDisTubeSongs = newIndex + 1;

        // console.log(`[API REORDER] Current queue.songs length: ${queue.songs.length}`); // Kept as per your code
        // console.log(`[API REORDER] Client indices: old=${oldIndex}, new=${newIndex}. Actual indices for DisTube: old=${actualOldIdxInDisTubeSongs}, new=${actualNewIdxInDisTubeSongs}`); // Kept
        // console.log("[API REORDER] Queue songs BEFORE reorder:", JSON.stringify(queue.songs.map(s => s.name))); // Kept


        if (actualOldIdxInDisTubeSongs <= 0 || actualOldIdxInDisTubeSongs >= queue.songs.length ||
            actualNewIdxInDisTubeSongs <= 0 || actualNewIdxInDisTubeSongs > queue.songs.length) { 
            console.error(`[API REORDER] Index out of bounds. actualOld: ${actualOldIdxInDisTubeSongs}, actualNew: ${actualNewIdxInDisTubeSongs}, songs.length: ${queue.songs.length}`);
            return res.status(400).json({ error: 'Reorder index out of bounds.' });
        }
        
        if (oldIndex === newIndex) { 
            return res.json({ message: 'Song position unchanged.' });
        }

        const songToMove = queue.songs.splice(actualOldIdxInDisTubeSongs, 1)[0];
        // console.log("[API REORDER] Song to move:", songToMove ? songToMove.name : 'NOT FOUND'); // Kept

        if (!songToMove) {
            console.error(`[API REORDER] Song to move not found at actualOldIdxInDisTubeSongs ${actualOldIdxInDisTubeSongs}.`);
            return res.status(404).json({ error: 'Song to move not found.' });
        }
        
        queue.songs.splice(actualNewIdxInDisTubeSongs, 0, songToMove); 
        
        // console.log("[API REORDER] Queue songs AFTER reorder:", JSON.stringify(queue.songs.map(s => s.name))); // Kept
        console.log(`[API REORDER] Reordered song: moved from upcoming index ${oldIndex} to ${newIndex}.`);
        res.json({ success: true, message: 'Queue reordered successfully.' });

    } catch (error) {
        console.error('[API REORDER] Error:', error);
        res.status(500).json({ error: error.message || 'Failed to reorder queue.' });
    }
});


app.post('/api/stop', async (req, res) => { try { const q = await getQueueFromEnv(res); if (!q) return; await q.stop(); res.json({ message: 'หยุดเล่นเพลงและล้างคิวแล้ว' }); } catch (e) { console.error('Stop API error:', e); res.status(500).json({ error: e.message }); }});
app.post('/api/skip', async (req, res) => { try { const q = await getQueueFromEnv(res); if (!q) return; if (q.songs.length <= 1 && !q.autoplay) { await q.stop(); return res.json({ message: 'ข้ามเพลงและหยุดเล่น (เพลงสุดท้ายพอดี)' }); } await q.skip(); res.json({ message: 'ข้ามเพลงปัจจุบันแล้ว' }); } catch (e) { console.error('Skip API error:', e); res.status(500).json({ error: e.message }); }});
app.post('/api/volume', async (req, res) => { try { const { volume } = req.body; if (typeof volume!=='number'||volume<0||volume>200) return res.status(400).json({error:'ระดับเสียงต้องเป็นตัวเลข 0-200'}); const q = await getQueueFromEnv(res); if(!q)return; q.setVolume(volume); res.json({message:`ตั้งค่าระดับเสียงเป็น ${volume}% แล้ว`}); } catch (e) { console.error('Volume API error:', e); res.status(500).json({error:e.message}); }});
app.post('/api/pause', async (req, res) => { try { const q = await getQueueFromEnv(res); if(!q)return; if(q.paused)return res.status(400).json({error:'เพลงหยุดเล่นอยู่แล้ว'}); q.pause(); res.json({message:'หยุดเล่นเพลงชั่วคราว'}); } catch (e) { console.error('Pause API error:', e); res.status(500).json({error:e.message}); }});
app.post('/api/resume', async (req, res) => { try { const q = await getQueueFromEnv(res); if(!q)return; if(!q.paused)return res.status(400).json({error:'เพลงกำลังเล่นอยู่แล้ว'}); q.resume(); res.json({message:'เล่นเพลงต่อแล้ว'}); } catch (e) { console.error('Resume API error:', e); res.status(500).json({error:e.message}); }});
app.get('/api/search', async (req, res) => { try { const {q}=req.query; if(!q)return res.status(400).json({error:'ต้องใส่คำค้นหา (q) ด้วยนะ'}); const results = await distube.search(q, {limit:10, type:'video', safeSearch:true}); const items = results.map(v => ({id:{videoId:v.id},snippet:{title:v.name,channelTitle:v.uploader?.name||'N/A',thumbnails:{medium:{url:v.thumbnail}}}})); res.json({items}); } catch (e) { console.error('Search API error:', e); res.status(500).json({error:e.message}); }});
app.post('/api/remove', async (req, res) => { try { const {index}=req.body; if(typeof index!=='number'||index<0)return res.status(400).json({error:'ต้องระบุ index เพลงที่ถูกต้อง'}); const q=await getQueueFromEnv(res); if(!q)return; if(index>=q.songs.length-1)return res.status(400).json({error:'Index อยู่นอกช่วงของเพลงในคิว'}); const removed=q.songs.splice(index+1,1)[0]; res.json({success:true,message:`ลบเพลง "${removed.name}" ออกจากคิวแล้ว`}); } catch (e) { console.error('Remove API error:',e); res.status(500).json({error:'ลบเพลงไม่สำเร็จ'}); }});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'client', 'index.html')));
app.use((err, req, res, next) => { console.error('Server error stack:', err.stack); res.status(500).json({ error: err.message || 'Internal server error' }); });

const portToListen = process.env.PORT || 3000;
app.listen(portToListen, () => { console.log(`Server running on port ${portToListen}`); console.log(`Web UI available at ${WEB_UI_BASE_URL}/index.html (or just ${WEB_UI_BASE_URL}/)`); });
client.login(process.env.DISCORD_TOKEN).catch(error => { console.error('Discord login error:', error); process.exit(1); });

setInterval(() => {
    const now = Date.now();
    for (const [token, session] of activeSessions.entries()) {
        if (now - session.timestamp > SESSION_TOKEN_EXPIRY_MS) { 
            activeSessions.delete(token);
            console.log(`Session token ${token} ของ ${session.userName} auto-cleaned after 1 day.`);
        }
    }
}, 60 * 60 * 1000);