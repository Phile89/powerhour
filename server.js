require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const { getOwners } = require('./owners');
const cron = require('node-cron');
const { generateDailyDigest, formatDigestMessage } = require('./digest');

// Create a Bolt Receiver for webhooks and Slack commands
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: {
    events: '/slack/events',
    commands: '/slack/commands'
  }
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

receiver.app.use(require('express').json());

let activeSessions = {};
let owners = {};

(async () => {
  owners = await getOwners();
})();

// --- COMMANDS ---

app.command('/powerhour', async ({ command, ack, say, client }) => {
  await ack();
  const args = command.text.trim().split(' ');
  const action = args[0].toLowerCase();
  const channelId = command.channel_id;

  if (action === 'start') {
    if (activeSessions[channelId]) {
      await say("A Power Hour is already running in this channel!");
      return;
    }

    // Parse duration (default 60 minutes)
    const duration = parseInt(args[1]) || 60;

    const today = new Date();
    const dateOptions = { weekday: 'long', month: 'long', day: 'numeric' };
    const formattedDate = today.toLocaleDateString('en-US', dateOptions);

    activeSessions[channelId] = {
      channelId: channelId,
      messageTs: null,
      repStats: {},
      previousLeaderboard: [],
      interval: null,
      inactivityInterval: null,
      finalPushTimeout: null,
      halfwayTimeout: null,
      autoStopTimeout: null,
      startTime: Date.now(),
      duration: duration, // in minutes
      teamDemos: 0,
      teamGoalAnnounced: false
    };
    
    const rules = ">*Power Hour Scoring:*\n> • *5 points* per Demo Booked\n> • *2 points* per Conversation (call over 2 mins)\n> • *1 point* per Connection (answered call)";
    const title = `⚡ *POWER HOUR STARTED for ${formattedDate}!* ⚡\n_Running for ${duration} minutes_\nTracking activity in real-time...\n\n${rules}`;
    const leaderboardText = `📊 *LIVE LEADERBOARD*\n> _Waiting for activity..._`;
    const tipText = "💡 Tip: Use `/leaderboard` at any time to see the current standings.";
    const simpleText = `Power Hour Started for ${formattedDate}!`;

    const result = await say({
        text: simpleText,
        blocks: [
          { "type": "section", "text": { "type": "mrkdwn", "text": title } },
          { "type": "context", "elements": [ { "type": "mrkdwn", "text": tipText } ] },
          { "type": "divider" },
          { "type": "section", "text": { "type": "mrkdwn", "text": leaderboardText } }
        ]
    });
    activeSessions[channelId].messageTs = result.ts;

    // Start a 10-minute interval to update the leaderboard
    activeSessions[channelId].interval = setInterval(() => {
      updateLeaderboard(app.client, channelId);
    }, 600000); // 10 minutes

    // Check for inactivity every 5 minutes
    activeSessions[channelId].inactivityInterval = setInterval(() => {
      checkInactivity(channelId);
    }, 300000); // 5 minutes

    // Schedule halfway alert
    const halfwayTime = (duration / 2) * 60 * 1000; // Convert to milliseconds
    if (halfwayTime > 0) {
      activeSessions[channelId].halfwayTimeout = setTimeout(() => {
        halfwayAlert(channelId, duration);
      }, halfwayTime);
    }

    // Schedule final push alert (10 minutes before end)
    const finalPushTime = (duration - 10) * 60 * 1000; // Convert to milliseconds
    if (finalPushTime > 0) {
      activeSessions[channelId].finalPushTimeout = setTimeout(() => {
        finalPushAlert(channelId);
      }, finalPushTime);
    }

  } else if (action === 'stop') {
    if (!activeSessions[channelId]) {
      await say("There's no active Power Hour to stop in this channel.");
      return;
    }
    
    // Clear all intervals and timeouts
    clearInterval(activeSessions[channelId].interval);
    clearInterval(activeSessions[channelId].inactivityInterval);
    clearTimeout(activeSessions[channelId].finalPushTimeout);
    clearTimeout(activeSessions[channelId].halfwayTimeout);
    clearTimeout(activeSessions[channelId].autoStopTimeout);

    await say('🏁 *Power Hour Complete!* Generating final results...');
    await updateLeaderboard(client, channelId, true);
    
    delete activeSessions[channelId];
    
  } else {
    await say('Usage: `/powerhour start [duration in minutes]` or `/powerhour stop`\nExample: `/powerhour start 60` for a 60-minute power hour');
  }
});
// Auto-stop power hour after duration
activeSessions[channelId].autoStopTimeout = setTimeout(async () => {
  await say('🏁 *Power Hour Complete!* Time\'s up! Generating final results...');
  await updateLeaderboard(client, channelId, true);
  
  // Clear intervals
  clearInterval(activeSessions[channelId].interval);
  clearInterval(activeSessions[channelId].inactivityInterval);
  clearTimeout(activeSessions[channelId].finalPushTimeout);
  clearTimeout(activeSessions[channelId].halfwayTimeout);
  
  delete activeSessions[channelId];
}, duration * 60 * 1000); // Convert minutes to milliseconds

app.command('/leaderboard', async ({ command, ack, respond }) => {
  await ack();
  const channelId = command.channel_id;
  const session = activeSessions[channelId];

  if (!session || !session.repStats) {
    await respond({ response_type: 'ephemeral', text: "There is no active Power Hour running in this channel." });
    return;
  }

  const repNames = Object.keys(session.repStats);
  if (repNames.length === 0) {
      await respond({ response_type: 'ephemeral', text: "Here is the current leaderboard:\n> _No activity yet..._" });
      return;
  }

  const leaderboard = repNames.map(name => {
      const stats = session.repStats[name];
      // Power Hour scoring: connections (1pt) + conversations (2pts) + demos (5pts)
      const connectionPoints = (stats.connections || 0) * 1;
      const conversationPoints = (stats.conversations || 0) * 2;
      const demoPoints = (stats.demos || 0) * 5;
      return { 
        name, 
        score: connectionPoints + conversationPoints + demoPoints,
        connections: stats.connections || 0,
        conversations: stats.conversations || 0,
        demos: stats.demos || 0
      };
  }).sort((a, b) => b.score - a.score);

  let message = "Here is the current leaderboard:\n\n";
  leaderboard.forEach((rep, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `   ${index + 1}.`;
    message += `> ${medal} *${rep.name}* - ${rep.score} pts _(${rep.connections} connections, ${rep.conversations} conversations, ${rep.demos} demos)_\n`;
  });

  await respond({ response_type: 'ephemeral', text: message });
});

app.command('/dailysummary', async ({ command, ack, client }) => {
  await ack();
  
  const channelId = command.channel_id;
  const dateArg = command.text.trim();
  
  // Parse the date argument
  let targetDate = new Date();
  if (dateArg) {
    if (dateArg.toLowerCase() === 'yesterday') {
      targetDate.setDate(targetDate.getDate() - 1);
    } else {
      // Try to parse as YYYY-MM-DD
const parsed = new Date(dateArg + 'T12:00:00'); // Add midday time to avoid timezone issues
if (!isNaN(parsed.getTime())) {
  targetDate = parsed;
}
    }
  }
  
  const dateString = targetDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  
  await client.chat.postMessage({
    token: process.env.SLACK_BOT_TOKEN,
    channel: channelId,
    text: `📊 Generating digest for ${dateString}...`
  });
  
  try {
    const digest = await generateDailyDigest(owners, true, targetDate);
    const message = formatDigestMessage(digest);
    
    await client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel: channelId,
      text: message
    });
  } catch (error) {
    console.error('Error generating digest:', error);
    await client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel: channelId,
      text: 'Sorry, there was an error generating the summary. Check the logs.'
    });
  }
});

// --- WEBHOOK HANDLERS ---

receiver.app.post('/webhooks/hubspot', async (req, res) => {
  console.log('HubSpot webhook received');
  try {
    for (const event of req.body) {
      if (event.subscriptionType === 'deal.propertyChange' && event.propertyName === 'dealstage') {
        const deal = await getHubSpotDeal(event.objectId);
        if (deal && deal.properties.dealstage === '098183b8-daf7-4145-b7af-17dd19c077f9') {
          await handleNewDemo(deal, deal.properties.hubspot_owner_id);
        }
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error processing HubSpot webhook:', error);
    res.status(500).send('Error');
  }
});

receiver.app.post('/webhooks/aircall', async (req, res) => {
  const event = req.body;
  console.log(`Aircall webhook received: ${event.event}`);
  try {
    if (event.event === 'call.answered') {
        // Track connections (answered calls)
        await handleConnection(event.data);
    } else if (event.event === 'call.ended') {
      if (event.data.duration >= 120) {
        // Track conversations (2+ min calls)
        await handleConversation(event.data);
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error processing Aircall webhook:', error);
    res.status(500).send('Error');
  }
});


// --- LOGIC FUNCTIONS ---

// Handle connection (answered call - any duration)
async function handleConnection(call) {
  const userName = call.user?.name || 'Unknown';
  
  // Get sales team from env (comma-separated list)
  const salesTeam = process.env.SALES_TEAM ? 
    process.env.SALES_TEAM.split(',').map(name => name.trim().toLowerCase()) : 
    [];
  
  // Only track if this person is on the sales team
  if (salesTeam.length > 0 && !salesTeam.includes(userName.toLowerCase())) {
    console.log(`Ignoring call from ${userName} - not on sales team`);
    return;
  }
  
  for (const channelId in activeSessions) {
    const session = activeSessions[channelId];
    if (!session) continue;
    
    let userStats = session.repStats[userName];
    if (!userStats) {
      userStats = { 
        connections: 0, 
        conversations: 0, 
        demos: 0, 
        dials: 0, 
        lastActivity: Date.now(), 
        activityTimestamps: [] 
      };
      session.repStats[userName] = userStats;
    }

    userStats.connections = (userStats.connections || 0) + 1;
    userStats.dials = (userStats.dials || 0) + 1;
    userStats.lastActivity = Date.now();
    const callAttemptNumber = userStats.dials;
    
    if (callAttemptNumber === 1 || callAttemptNumber % 10 === 0) {
      const ordinal = (n) => {
        const s = ["th", "st", "nd", "rd"], v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
      };
      const message = (callAttemptNumber === 1)
        ? `🤙 *${userName}* is making their **1st call** of the hour!`
        : `⚡️ *${userName}* just made their **${ordinal(callAttemptNumber)} call**! Keep it up!`;
      await postMessage(channelId, message);
    }
  }
}

// Handle conversation (call over 2 mins)
async function handleConversation(call) {
  const userName = call.user?.name || 'Unknown';
  
  // Get sales team from env (comma-separated list)
  const salesTeam = process.env.SALES_TEAM ? 
    process.env.SALES_TEAM.split(',').map(name => name.trim().toLowerCase()) : 
    [];
  
  // Only track if this person is on the sales team
  if (salesTeam.length > 0 && !salesTeam.includes(userName.toLowerCase())) {
    console.log(`Ignoring completed call from ${userName} - not on sales team`);
    return;
  }
  
  const duration = Math.round(call.duration / 60);
  
  for (const channelId in activeSessions) {
    const session = activeSessions[channelId];
    if (!session) continue;
     
    if (!session.repStats[userName]) {
      session.repStats[userName] = { 
        connections: 0, 
        conversations: 0, 
        demos: 0, 
        dials: 0, 
        lastActivity: Date.now(), 
        activityTimestamps: [] 
      };
    }
    session.repStats[userName].conversations = (session.repStats[userName].conversations || 0) + 1;
    session.repStats[userName].lastActivity = Date.now();
    session.repStats[userName].activityTimestamps.push({ type: 'conversation', time: Date.now() });
    
    await postMessage(channelId, `📞 *${userName}* just completed a ${duration} min call!`);
    
    // Check for hot streak (5+ conversations in 30 minutes)
    checkHotStreak(channelId, userName, 'conversation');
  }
}

async function handleNewDemo(deal, ownerId) {
  const ownerName = owners[ownerId] || `Owner ${ownerId}`;
  const dealName = deal.properties.dealname || 'a new client';

  for (const channelId in activeSessions) {
    const session = activeSessions[channelId];
    if (!session) continue;
    
    if (!session.repStats[ownerName]) {
      session.repStats[ownerName] = { 
        connections: 0, 
        conversations: 0, 
        demos: 0, 
        dials: 0, 
        lastActivity: Date.now(), 
        activityTimestamps: [] 
      };
    }
    session.repStats[ownerName].demos = (session.repStats[ownerName].demos || 0) + 1;
    session.repStats[ownerName].lastActivity = Date.now();
    session.repStats[ownerName].activityTimestamps.push({ type: 'demo', time: Date.now() });
    
    // Track team demos
    session.teamDemos += 1;
    
    const gifUrl = await getRandomGif('office celebration excited team');
    const messageText = `🔥 *${ownerName}* just booked a demo with *${dealName}*! 🎯`;
    
    await postMessageWithGif(channelId, messageText, gifUrl);
    
    // Check for hot streak (2+ demos in 20 minutes)
    checkHotStreak(channelId, ownerName, 'demo');
    
    // Check for team goal
    checkTeamGoal(channelId);
  }
}

function checkHotStreak(channelId, userName, activityType) {
  const session = activeSessions[channelId];
  if (!session) return;
  
  const userStats = session.repStats[userName];
  if (!userStats) return;
  
  const now = Date.now();
  const timestamps = userStats.activityTimestamps || [];
  
  if (activityType === 'demo') {
    // Check for 2+ demos in 20 minutes
    const recentDemos = timestamps.filter(t => t.type === 'demo' && (now - t.time) < 20 * 60 * 1000);
    if (recentDemos.length >= 2) {
      postMessage(channelId, `🔥 *${userName}* IS ON FIRE! ${recentDemos.length} demos in 20 minutes! 🔥`);
      // Clear timestamps to avoid repeated notifications
      userStats.activityTimestamps = timestamps.filter(t => t.type !== 'demo' || (now - t.time) >= 20 * 60 * 1000);
    }
  } else if (activityType === 'conversation') {
    // Check for 5+ conversations in 30 minutes
    const recentCalls = timestamps.filter(t => t.type === 'conversation' && (now - t.time) < 30 * 60 * 1000);
    if (recentCalls.length >= 5) {
      postMessage(channelId, `⚡ *${userName}* is a DIALING MACHINE! ${recentCalls.length} calls in 30 minutes! ⚡`);
      // Clear timestamps to avoid repeated notifications
      userStats.activityTimestamps = timestamps.filter(t => t.type !== 'conversation' || (now - t.time) >= 30 * 60 * 1000);
    }
  }
}

function checkTeamGoal(channelId) {
  const session = activeSessions[channelId];
  if (!session || session.teamGoalAnnounced || !process.env.PRIZE_NAME) return;
  
  if (session.teamDemos >= 12) {
    const prizeName = process.env.PRIZE_NAME;
    postMessage(channelId, `🎉 🎉 🎉 TEAM GOAL ACHIEVED! 🎉 🎉 🎉\n\n12 demos booked! *${prizeName}* unlocked for the team! 🏆`);
    session.teamGoalAnnounced = true;
  }
}

function checkInactivity(channelId) {
  const session = activeSessions[channelId];
  if (!session) return;
  
  const now = Date.now();
  const fifteenMinutes = 15 * 60 * 1000;
  
  for (const userName in session.repStats) {
    const userStats = session.repStats[userName];
    const timeSinceActivity = now - (userStats.lastActivity || now);
    
    if (timeSinceActivity >= fifteenMinutes && userStats.dials > 0) {
      postMessage(channelId, `👀 *${userName}* hasn't made a call in 15 minutes... 👀`);
      // Update lastActivity to avoid repeated notifications
      userStats.lastActivity = now;
    }
  }
}

async function halfwayAlert(channelId, totalDuration) {
  const session = activeSessions[channelId];
  if (!session) return;
  
  const repNames = Object.keys(session.repStats);
  if (repNames.length === 0) {
    await postMessage(channelId, `⏰ *HALFWAY THERE!* ${totalDuration / 2} minutes down, ${totalDuration / 2} to go! 📞`);
    return;
  }
  
  const leaderboard = repNames.map(name => {
      const stats = session.repStats[name];
      const connectionPoints = (stats.connections || 0) * 1;
      const conversationPoints = (stats.conversations || 0) * 2;
      const demoPoints = (stats.demos || 0) * 5;
      return { 
        name, 
        score: connectionPoints + conversationPoints + demoPoints,
        connections: stats.connections || 0,
        conversations: stats.conversations || 0,
        demos: stats.demos || 0
      };
  }).sort((a, b) => b.score - a.score);
  
  let message = `⏰ *HALFWAY THERE!* ⏰\n${totalDuration / 2} minutes down, ${totalDuration / 2} to go!\n\nCurrent standings:\n`;
  leaderboard.forEach((rep, index) => {
    message += `${index + 1}. *${rep.name}* - ${rep.score} pts\n`;
  });
  
  if (leaderboard.length > 1) {
    const gap = leaderboard[0].score - leaderboard[1].score;
    if (gap <= 5) {
      message += `\n🔥 It's neck and neck! Only ${gap} points between 1st and 2nd! 🔥`;
    } else {
      message += `\n💪 Keep pushing! Plenty of time to catch up!`;
    }
  }
  
  await postMessage(channelId, message);
}

async function finalPushAlert(channelId) {
  const session = activeSessions[channelId];
  if (!session) return;
  
  const repNames = Object.keys(session.repStats);
  if (repNames.length === 0) {
    await postMessage(channelId, "⏰ *10 MINUTES LEFT!* Time to make it count! 📞");
    return;
  }
  
  const leaderboard = repNames.map(name => {
      const stats = session.repStats[name];
      const connectionPoints = (stats.connections || 0) * 1;
      const conversationPoints = (stats.conversations || 0) * 2;
      const demoPoints = (stats.demos || 0) * 5;
      return { 
        name, 
        score: connectionPoints + conversationPoints + demoPoints,
        connections: stats.connections || 0,
        conversations: stats.conversations || 0,
        demos: stats.demos || 0
      };
  }).sort((a, b) => b.score - a.score);
  
  let message = "⏰ *10 MINUTES LEFT!* ⏰\n\nCurrent standings:\n";
  leaderboard.forEach((rep, index) => {
    message += `${index + 1}. *${rep.name}* - ${rep.score} pts\n`;
  });
  
  if (leaderboard.length > 1) {
    const gap = leaderboard[0].score - leaderboard[1].score;
    if (gap <= 5) {
      message += `\n🔥 It's CLOSE! Only ${gap} points between 1st and 2nd! Still anyone's game! 🔥`;
    } else {
      message += `\n💪 Final push! Can anyone catch ${leaderboard[0].name}?`;
    }
  }
  
  await postMessage(channelId, message);
}

async function updateLeaderboard(client, channelId, isFinal = false) {
  const session = activeSessions[channelId];
  if (!session) return;
  
  const repNames = Object.keys(session.repStats);
  const leaderboard = repNames.map(name => {
      const stats = session.repStats[name];
      const connectionPoints = (stats.connections || 0) * 1;
      const conversationPoints = (stats.conversations || 0) * 2;
      const demoPoints = (stats.demos || 0) * 5;
      return { 
        name, 
        score: connectionPoints + conversationPoints + demoPoints,
        connections: stats.connections || 0,
        conversations: stats.conversations || 0,
        demos: stats.demos || 0
      };
  }).sort((a, b) => b.score - a.score);
  
  await generateDynamicCommentary(channelId, leaderboard, session.previousLeaderboard);
  session.previousLeaderboard = leaderboard;

  let message = `📊 *${isFinal ? 'FINAL' : 'LIVE'} LEADERBOARD* 📊\n\n`;
  if (leaderboard.length === 0) {
    message += `> _Waiting for activity..._`;
  } else {
    leaderboard.forEach((rep, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `   ${index + 1}.`;
      message += `> ${medal} *${rep.name}* - ${rep.score} pts _(${rep.connections} connections, ${rep.conversations} conversations, ${rep.demos} demos)_\n`;
    });
  }
  
// Add team progress (only if prize is enabled)
if (session.teamDemos > 0 && process.env.PRIZE_NAME) {
  message += `\n> \n> 🎯 *Team Progress:* ${session.teamDemos}/12 demos toward ${process.env.PRIZE_NAME}`;
}
  
  if (!isFinal) {
    message += `\n> \n> _Updated: ${new Date().toLocaleTimeString()}_`;
  }
  
  try {
    if (isFinal) {
        await postMessage(channelId, message);
    } else if (session.messageTs) {
        await client.chat.update({ channel: channelId, ts: session.messageTs, text: message });
    }
  } catch (error) {
    console.error('Error updating leaderboard:', error);
  }
}

async function generateDynamicCommentary(channelId, currentBoard, prevBoard) {
  if (prevBoard.length < 1 || currentBoard.length < 1) return;
  if (currentBoard[0].name !== prevBoard[0].name) {
    await postMessage(channelId, `🏆 *${currentBoard[0].name}* has just taken the lead!`);
  }
}


// --- UTILITY FUNCTIONS ---

async function getRandomGif(searchTerm) {
  try {
    const res = await require('axios').get('https://api.giphy.com/v1/gifs/search', {
      params: { api_key: process.env.GIPHY_API_KEY, q: searchTerm, limit: 25, rating: 'g' }
    });
    const results = res.data.data;
    if (results.length === 0) return null;
    return results[Math.floor(Math.random() * results.length)].images.original.url;
  } catch (error) { console.error('Giphy API error:', error.message); return null; }
}

async function getHubSpotDeal(dealId) {
  try {
    const res = await require('axios').get(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
        headers: { 'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}` },
        params: { properties: 'dealname,dealstage,hubspot_owner_id' }
    });
    return res.data;
  } catch (e) { console.error(`Failed to fetch HubSpot deal ${dealId}`, e.message); return null; }
}

async function postMessage(channelId, text) {
  try {
    await app.client.chat.postMessage({ token: process.env.SLACK_BOT_TOKEN, channel: channelId, text });
  } catch (error) { console.error('Error posting message:', error); }
}

async function postMessageWithGif(channelId, text, gifUrl) {
    try {
        await app.client.chat.postMessage({
            token: process.env.SLACK_BOT_TOKEN,
            channel: channelId,
            text,
            blocks: [
                { "type": "section", "text": { "type": "mrkdwn", "text": text } },
                ...(gifUrl ? [{ "type": "image", "image_url": gifUrl, "alt_text": "Celebratory GIF" }] : [])
            ]
        });
    } catch (error) { console.error('Error posting GIF message:', error); }
}
// Schedule daily digest for 6pm PT (18:00)
// Cron runs in UTC, so we need to adjust for PT
// PT is UTC-8 (PST) or UTC-7 (PDT)
// 6pm PT = 2am UTC (during PDT) or 3am UTC (during PST)
// Using 2am UTC to match PDT (covers most of the year)
cron.schedule('0 18 * * 1-5', async () => {
  console.log('Running scheduled daily digest...');
  
  const digestChannelId = process.env.DIGEST_CHANNEL_ID;
  if (!digestChannelId) {
    console.error('DIGEST_CHANNEL_ID not set in .env');
    return;
  }
  
  try {
    const digest = await generateDailyDigest(owners, true);
    const message = formatDigestMessage(digest);
    
    await app.client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel: digestChannelId,
      text: message
    });
    
    console.log('Daily digest posted successfully');
  } catch (error) {
    console.error('Error posting scheduled digest:', error);
  }
}, {
  timezone: "America/Los_Angeles"
});

// Start the app
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Power Hour Bot v2.0 is running!');
})();