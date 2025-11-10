require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const { getOwners } = require('./owners');

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
  const action = command.text.trim().toLowerCase();
  const channelId = command.channel_id;

  if (action === 'start') {
    if (activeSessions[channelId]) {
      await say("A Power Hour is already running in this channel!");
      return;
    }

    const today = new Date();
    const dateOptions = { weekday: 'long', month: 'long', day: 'numeric' };
    const formattedDate = today.toLocaleDateString('en-US', dateOptions);

    activeSessions[channelId] = {
      channelId: channelId,
      messageTs: null,
      repStats: {},
      previousLeaderboard: [],
      interval: null // To hold our 10-minute timer
    };
    
    const rules = ">*Scoring Rules:*\n> • *5 points* per Demo Booked\n> • *1 point* per Call (over 2 mins)";
    const title = `⚡ *POWER HOUR STARTED for ${formattedDate}!* ⚡\nTracking activity in real-time...\n\n${rules}`;
    const leaderboardText = `📊 *LIVE LEADERBOARD*\n> _Waiting for activity..._`;
    const tipText = "💡 Tip: Use `/leaderboard` at any time to see the current standings.";
    const simpleText = `Power Hour Started for ${formattedDate}!`;

    const result = await say({
        text: simpleText,
        blocks: [ { "type": "section", "text": { "type": "mrkdwn", "text": title } }, { "type": "context", "elements": [ { "type": "mrkdwn", "text": tipText } ] }, { "type": "divider" }, { "type": "section", "text": { "type": "mrkdwn", "text": leaderboardText } } ]
    });
    activeSessions[channelId].messageTs = result.ts;

    // Start a 10-minute interval to update the leaderboard
    activeSessions[channelId].interval = setInterval(() => {
      updateLeaderboard(app.client, channelId);
    }, 600000); // 10 minutes

  } else if (action === 'stop') {
    if (!activeSessions[channelId]) {
      await say("There's no active Power Hour to stop in this channel.");
      return;
    }
    
    // Stop the 10-minute timer
    clearInterval(activeSessions[channelId].interval);

    await say('🏁 *Power Hour Complete!* Generating final results...');
    await updateLeaderboard(client, channelId, true);
    
    delete activeSessions[channelId];
    
  } else {
    await say('Usage: `/powerhour start` or `/powerhour stop`');
  }
});

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
      return { name, score: (stats.calls * 1) + (stats.demos * 5), calls: stats.calls, demos: stats.demos };
  }).sort((a, b) => b.score - a.score);

  let message = "Here is the current leaderboard:\n\n";
  leaderboard.forEach((rep, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `   ${index + 1}.`;
    message += `> ${medal} *${rep.name}* - ${rep.score} pts _(${rep.calls} calls, ${rep.demos} demos)_\n`;
  });

  await respond({ response_type: 'ephemeral', text: message });
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
    if (event.event === 'call.created') {
        await handleNewDial(event.data);
    } else if (event.event === 'call.ended' && event.data.duration >= 120) {
      await handleNewCall(event.data);
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error processing Aircall webhook:', error);
    res.status(500).send('Error');
  }
});


// --- LOGIC FUNCTIONS ---

async function handleNewDial(call) {
  const userName = call.user?.name || 'Someone';
  for (const channelId in activeSessions) {
    const session = activeSessions[channelId];
    if (!session) continue;
    
    let userStats = session.repStats[userName];
    if (!userStats) {
      userStats = { calls: 0, demos: 0, dials: 0 };
      session.repStats[userName] = userStats;
    }

    userStats.dials = (userStats.dials || 0) + 1;
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

async function handleNewDemo(deal, ownerId) {
  const ownerName = owners[ownerId] || `Owner ${ownerId}`;
  const dealName = deal.properties.dealname || 'a new client';

  for (const channelId in activeSessions) {
    const session = activeSessions[channelId];
    if (!session) continue;
    
    if (!session.repStats[ownerName]) {
      session.repStats[ownerName] = { calls: 0, demos: 0, dials: 0 };
    }
    session.repStats[ownerName].demos += 1;
    
    const gifUrl = await getRandomGif('celebration cheering');
    const messageText = `🔥 *${ownerName}* just booked a demo with *${dealName}*! 🎯`;
    
    await postMessageWithGif(channelId, messageText, gifUrl);
    // Note: We no longer call updateLeaderboard here
  }
}

async function handleNewCall(call) {
  const userName = call.user?.name || 'Someone';
  const duration = Math.round(call.duration / 60);
  const contactName = call.contact?.company_name || call.contact?.name || call.number;
  
  for (const channelId in activeSessions) {
    const session = activeSessions[channelId];
    if (!session) continue;
     
    if (!session.repStats[userName]) {
      session.repStats[userName] = { calls: 0, demos: 0, dials: 0 };
    }
    session.repStats[userName].calls += 1;
    
    await postMessage(channelId, `📞 *${userName}* just completed a ${duration} min call with *${contactName}*!`);
    // Note: We no longer call updateLeaderboard here
  }
}

async function updateLeaderboard(client, channelId, isFinal = false) {
  const session = activeSessions[channelId];
  if (!session) return;
  
  const repNames = Object.keys(session.repStats);
  const leaderboard = repNames.map(name => {
      const stats = session.repStats[name];
      return { name, score: (stats.calls * 1) + (stats.demos * 5), calls: stats.calls, demos: stats.demos };
  }).sort((a, b) => b.score - a.score);
  
  await generateDynamicCommentary(channelId, leaderboard, session.previousLeaderboard);
  session.previousLeaderboard = leaderboard;

  let message = `📊 *${isFinal ? 'FINAL' : 'LIVE'} LEADERBOARD* 📊\n\n`;
  if (leaderboard.length === 0) {
    message += `> _Waiting for activity..._`;
  } else {
    leaderboard.forEach((rep, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `   ${index + 1}.`;
      message += `> ${medal} *${rep.name}* - ${rep.score} pts _(${rep.calls} calls, ${rep.demos} demos)_\n`;
    });
  }
  
  if (!isFinal) {
    message += `\n> \n> _Updated: ${new Date().toLocaleTimeString()}_`;
  }
  
  try {
    if (isFinal) {
        await postMessage(channelId, message);
    } else if (session.messageTs) { // Only update if we have a message to update
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

// Start the app
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Power Hour Bot v1.1 (Final) is running!');
})();
