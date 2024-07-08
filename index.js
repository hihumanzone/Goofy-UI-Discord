require('dotenv').config();
const { Client, Events, GatewayIntentBits, Partials } = require('discord.js');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy: DiscordStrategy } = require('passport-discord');
const bodyParser = require('body-parser');
const ejs = require('ejs');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');

const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

// Load environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CALLBACK_URL = process.env.CALLBACK_URL;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !CLIENT_ID || !CLIENT_SECRET || !CALLBACK_URL) {
  console.error("Please set BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, and CALLBACK_URL in your .env file");
  process.exit(1);
}

// Configure Passport
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
  clientID: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  callbackURL: CALLBACK_URL,
  scope: ['identify', 'guilds']
}, async (accessToken, refreshToken, profile, done) => {
  try {
    profile.guilds = profile.guilds.filter(guild => client.guilds.cache.has(guild.id));
    return done(null, profile);
  } catch (err) {
    return done(err, null);
  }
}));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('view engine', 'ejs');
app.use(session({ secret: 'supersecret', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => res.redirect('/dashboard')
);

app.get('/dashboard', checkAuth, async (req, res) => {
  if (!req.user) {
    return res.status(401).send('Unauthorized');
  }
  const user = req.user;
  const guilds = user.guilds;
  res.render('index', { user, guilds });
});

app.post('/send-message', checkAuth, upload.array('attachments', 10), async (req, res) => {
  const { guildId, channelId, message } = req.body;
  const files = req.files || [];
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.status(400).json({ message: 'Guild not found' });

  const channel = guild.channels.cache.get(channelId);
  if (!channel) return res.status(400).json({ message: 'Channel not found' });

  try {
    let webhook = await channel.fetchWebhooks().then(webhooks => webhooks.find(wh => wh.name === 'make people bot'));
    if (!webhook) {
      console.log('No webhook named "make people bot" found, creating a new one...');
      webhook = await channel.createWebhook({
        name: 'make people bot',
        avatar: client.user.displayAvatarURL()
      });
      console.log(`Webhook created with ID: ${webhook.id}`);
    }

    const options = {
      content: message,
      username: req.user.username,
      avatarURL: `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png`
    };

    if (files.length > 0) {
      options.files = files.map(file => ({
        attachment: file.buffer,
        name: file.originalname
      }));
    }

    const sentMessage = await webhook.send(options);
    res.json({ message: '✅' });
  } catch (error) {
    console.error('An error occurred while sending the message:', error);
    res.status(500).json({ message: 'An error occurred while sending the message' });
  }
});

const processMessage = async (message) => {
  if (message.partial) await message.fetch();

  const attachments = message.attachments.map(attachment => ({
    url: attachment.url,
    name: attachment.name
  }));

  const stickers = message.stickers.map(sticker => {
    const urlParts = sticker.url.split('.');
    const extension = urlParts[urlParts.length - 1];
    return {
      url: sticker.url,
      name: `${sticker.name}.${extension}`
    };
  });

  const customEmojiRegex = /<a?:\w+:\d+>/g;
  const customEmojis = message.content.match(customEmojiRegex) || [];
  const formattedCustomEmojis = customEmojis.map(em => {
    const isAnimated = em.startsWith('<a:');
    const name = em.slice(em.indexOf(':') + 1, em.lastIndexOf(':'));
    const id = em.slice(em.lastIndexOf(':') + 1, -1);
    const extension = isAnimated ? 'gif' : 'png';
    return {
      url: `https://cdn.discordapp.com/emojis/${id}.${extension}`,
      name: `${name}.${extension}`
    };
  });

  let updatedContent = message.content;
  customEmojis.forEach(em => {
    const isAnimated = em.startsWith('<a:');
    const name = em.slice(em.indexOf(':') + 1, em.lastIndexOf(':'));
    updatedContent = updatedContent.replace(em, `:${name}:`);
  });

  const allAttachments = [...attachments, ...stickers, ...formattedCustomEmojis];

  const embeds = message.embeds.map(embed => ({
    title: embed.title,
    description: embed.description,
    url: embed.url,
    color: embed.hexColor,
    image: embed.image ? embed.image.url : null,
    thumbnail: embed.thumbnail ? embed.thumbnail.url : null,
    author: embed.author ? embed.author.name : null,
    fields: embed.fields
  }));

  let replyTo = null;
  if (message.reference?.messageId) {
    try {
      replyTo = await message.fetchReference();
    } catch (e) {
      console.warn(`Referenced message not found for message ${message.id}`);
    }
  }

  const reactions = await Promise.all(message.reactions.cache.map(async (reaction) => {
    const users = await reaction.users.fetch();
    const usernames = users.map(user => user.username);
    return {
      emoji: reaction.emoji.name,
      count: reaction.count,
      usernames
    };
  }));

  return {
    id: message.id,
    content: updatedContent,
    username: message.author.username,
    userId: message.author.id,
    avatarURL: message.author.displayAvatarURL(),
    createdAt: message.createdAt.toISOString(),
    isBot: message.author.bot,
    attachments: allAttachments,
    embeds,
    replyTo: replyTo ? {
      id: replyTo.id,
      content: replyTo.content,
      username: replyTo.author.username,
      userId: replyTo.author.id,
      avatarURL: replyTo.author.displayAvatarURL(),
      createdAt: replyTo.createdAt.toISOString(),
      isBot: replyTo.author.bot
    } : null,
    reactions
  };
};

client.on('messageCreate', async (message) => {
  const processedMessage = await processMessage(message);
  io.to(message.channel.id).emit('newMessage', processedMessage);
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  console.log(`Message updated: ${newMessage.id}`);
  const processedMessage = await processMessage(newMessage);
  io.to(newMessage.channel.id).emit('updateMessage', processedMessage);
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (reaction.message.partial) await reaction.message.fetch();
  const processedMessage = await processMessage(reaction.message);
  io.to(reaction.message.channelId).emit('updateMessage', processedMessage);
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (reaction.message.partial) await reaction.message.fetch();
  const processedMessage = await processMessage(reaction.message);
  io.to(reaction.message.channelId).emit('updateMessage', processedMessage);
});

io.on('connection', (socket) => {
  let currentChannelId = null;

  socket.on('joinChannel', (channelId) => {
    if (currentChannelId) {
      socket.leave(currentChannelId);
      console.log(`Socket left channel: ${currentChannelId}`);
    }
    currentChannelId = channelId;
    socket.join(channelId);
    console.log(`Socket joined channel: ${channelId}`);
  });

  socket.on('leaveChannel', (channelId) => {
    if (currentChannelId === channelId) {
      socket.leave(channelId);
      console.log(`Socket left channel: ${channelId}`);
      currentChannelId = null;
    }
  });
});

app.get('/get-channels', checkAuth, async (req, res) => {
  const { guildId } = req.query;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.status(400).send('Guild not found');

  const channels = guild.channels.cache
    .filter(channel => channel.type === 0)
    .map(channel => ({ id: channel.id, name: channel.name }));

  res.json(channels);
});

app.get('/get-messages', checkAuth, async (req, res) => {
  const { channelId, before } = req.query;
  const channel = client.channels.cache.get(channelId);
  if (!channel) return res.status(400).send('Channel not found');

  try {
    const options = { limit: 50 };
    if (before) options.before = before;

    const messages = await channel.messages.fetch(options);
    const messageArray = await Promise.all(
      messages.map(async (msg) => {
        try {
          return await processMessage(msg);
        } catch (msgError) {
          console.error(`Error processing message ${msg.id}:`, msgError);
          return null;
        }
      })
    );

    const filteredMessageArray = messageArray.filter(msg => msg !== null);
    res.json(filteredMessageArray);
  } catch (error) {
    res.status(500).send(`An error occurred while fetching messages: ${error}`);
  }
});

app.get('/get-channel-users', checkAuth, async (req, res) => {
  const { channelId } = req.query;
  const channel = client.channels.cache.get(channelId);

  if (!channel) return res.status(400).send('Channel not found');

  try {
    const members = await channel.guild.members.fetch();
    const sortedMembers = [...members.values()]
      .filter(member => !member.user.bot)
      .sort((a, b) => b.roles.highest.rawPosition - a.roles.highest.rawPosition);

    const limitedMembers = sortedMembers.slice(0, 50);

    const memberDetails = limitedMembers.map(member => ({
      id: member.id,
      username: member.user.username,
      status: member.presence?.status || 'offline'
    }));

    res.json(memberDetails);
  } catch (error) {
    console.error('Failed to fetch channel users:', error);
    res.status(500).send('Failed to fetch channel users.');
  }
});

app.get('/', (req, res) => {
  res.redirect('/auth/discord');
});

function checkAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/auth/discord');
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
});

client.login(BOT_TOKEN);

// Reconnection logic
client.on('disconnect', () => {
  console.log('Bot disconnected, attempting to reconnect...');
  setTimeout(() => client.login(BOT_TOKEN), 5000);
});

client.on('error', error => {
  console.error('Bot encountered an error:', error);
  client.destroy();
  setTimeout(() => client.login(BOT_TOKEN), 5000);
});

client.on('shardError', error => {
  console.error('Shard error:', error);
  client.destroy();
  setTimeout(() => client.login(BOT_TOKEN), 5000);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  client.destroy();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
