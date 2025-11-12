const axios = require('axios');

// Get start and end of a specific date in ISO format
function getDayRange(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    startMs: start.getTime(),
    endMs: end.getTime()
  };
}

// Get demos booked today (deals created with Demo Scheduled stage)
async function getDemosBookedToday(date = new Date()) {
  const { startMs, endMs } = getDayRange(date);
  
  try {
    const response = await axios.post('https://api.hubapi.com/crm/v3/objects/deals/search', {
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'dealstage',
              operator: 'EQ',
              value: '098183b8-daf7-4145-b7af-17dd19c077f9' // Demo Scheduled UUID
            },
            {
              propertyName: 'createdate',
              operator: 'GTE',
              value: startMs
            },
            {
              propertyName: 'createdate',
              operator: 'LTE',
              value: endMs
            }
          ]
        }
      ],
      properties: ['dealname', 'createdate', 'hubspot_owner_id'],
      limit: 100
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    
    return response.data.results || [];
  } catch (error) {
    console.error('Error fetching demos booked:', error.message);
    return [];
  }
}

// Get demos completed today (demo_completed_date__c = today)
async function getDemosCompletedToday(date = new Date()) {
  const dateString = date.toISOString().split('T')[0]; // YYYY-MM-DD format
  
  try {
    const response = await axios.post('https://api.hubapi.com/crm/v3/objects/deals/search', {
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'demo_completed_date__c',
              operator: 'EQ',
              value: dateString
            }
          ]
        }
      ],
      properties: ['dealname', 'demo_completed_date__c', 'hubspot_owner_id'],
      limit: 100
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    
    return response.data.results || [];
  } catch (error) {
    console.error('Error fetching demos completed:', error.message);
    return [];
  }
}

// Get all calls from Aircall for a specific day
// Get all calls from Aircall for a specific day
async function getCallsForDay(date = new Date()) {
  const { startMs, endMs } = getDayRange(date);
  const fromTimestamp = Math.floor(startMs / 1000);
  const toTimestamp = Math.floor(endMs / 1000);
  
  const auth = Buffer.from(`${process.env.AIRCALL_API_ID}:${process.env.AIRCALL_API_TOKEN}`).toString('base64');
  
  try {
    const response = await axios.get('https://api.aircall.io/v1/calls', {
      headers: {
        'Authorization': `Basic ${auth}`
      },
      params: {
        from: fromTimestamp,
        to: toTimestamp,
        per_page: 50
      }
    });
    
    // Return ALL answered calls (not just >2 mins)
    const answeredCalls = response.data.calls.filter(call => call.answered_at);
    return answeredCalls;
  } catch (error) {
    console.error('Error fetching Aircall calls:', error.message);
    return [];
  }
}

// Analyze calls to get metrics
function analyzeCallMetrics(calls) {
  if (calls.length === 0) {
    return {
      totalCalls: 0,
      totalMinutes: 0,
      averageDuration: 0,
      longestCall: null,
      mostActiveHour: null
    };
  }
  
  const totalSeconds = calls.reduce((sum, call) => sum + call.duration, 0);
  const totalMinutes = Math.round(totalSeconds / 60);
  const averageDuration = Math.round(totalSeconds / calls.length / 60);
  
  // Find longest call
  const longestCall = calls.reduce((longest, call) => 
    call.duration > (longest?.duration || 0) ? call : longest
  , null);
  
  // Find most active hour
  const hourCounts = {};
  calls.forEach(call => {
    const hour = new Date(call.started_at * 1000).getHours();
    hourCounts[hour] = (hourCounts[hour] || 0) + 1;
  });
  
  const mostActiveHour = Object.entries(hourCounts).reduce((max, [hour, count]) => 
    count > max.count ? { hour: parseInt(hour), count } : max
  , { hour: null, count: 0 });
  
  return {
    totalCalls: calls.length,
    totalMinutes,
    averageDuration,
    longestCall: longestCall ? {
      duration: Math.round(longestCall.duration / 60),
      user: longestCall.user?.name || 'Unknown',
      contact: longestCall.contact?.company_name || longestCall.contact?.name || longestCall.raw_digits || 'Unknown'
    } : null,
    mostActiveHour: mostActiveHour.hour !== null ? {
      hour: mostActiveHour.hour,
      count: mostActiveHour.count,
      formatted: formatHour(mostActiveHour.hour)
    } : null
  };
}

function formatHour(hour) {
  const period = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
  return `${displayHour}${period}`;
}

// Build leaderboard with scoring
// Build leaderboard with scoring
function buildLeaderboard(demosBooked, demosCompleted, calls, owners) {
  const repStats = {};
  
  // Count demos booked (3 points each)
  demosBooked.forEach(deal => {
    const ownerId = deal.properties.hubspot_owner_id;
    const ownerName = owners[ownerId] || `Owner ${ownerId}`;
    
    if (!repStats[ownerName]) {
      repStats[ownerName] = { demosBooked: 0, demosCompleted: 0, conversations: 0, connections: 0, score: 0 };
    }
    repStats[ownerName].demosBooked += 1;
  });
  
  // Count demos completed (5 points each)
  demosCompleted.forEach(deal => {
    const ownerId = deal.properties.hubspot_owner_id;
    const ownerName = owners[ownerId] || `Owner ${ownerId}`;
    
    if (!repStats[ownerName]) {
      repStats[ownerName] = { demosBooked: 0, demosCompleted: 0, conversations: 0, connections: 0, score: 0 };
    }
    repStats[ownerName].demosCompleted += 1;
  });
  
  // Count calls - separate connections (<2min) from conversations (>=2min)
  calls.forEach(call => {
    const userName = call.user?.name || 'Unknown';
    
    if (!repStats[userName]) {
      repStats[userName] = { demosBooked: 0, demosCompleted: 0, conversations: 0, connections: 0, score: 0 };
    }
    
    if (call.duration >= 120) {
      repStats[userName].conversations += 1; // 2 points
    } else {
      repStats[userName].connections += 1; // 1 point
    }
  });
  
  // Calculate scores: 5pts per demo completed, 3pts per demo booked, 2pts per conversation, 1pt per connection
  Object.values(repStats).forEach(stats => {
    stats.score = (stats.demosCompleted * 5) + (stats.demosBooked * 3) + (stats.conversations * 2) + (stats.connections * 1);
  });
  
  // Sort by score
  const leaderboard = Object.entries(repStats)
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.score - a.score);
  
  return leaderboard;
}

// Generate the full daily digest
async function generateDailyDigest(owners, includeComparison = true) {
  const today = new Date();
  const lastWeek = new Date(today);
  lastWeek.setDate(lastWeek.getDate() - 7);
  
  // Fetch today's data
  const [demosBookedToday, demosCompletedToday, callsToday] = await Promise.all([
    getDemosBookedToday(today),
    getDemosCompletedToday(today),
    getCallsForDay(today)
  ]);
  
  // Fetch last week's data for comparison
  let comparison = null;
  if (includeComparison) {
    const [demosBookedLastWeek, demosCompletedLastWeek, callsLastWeek] = await Promise.all([
      getDemosBookedToday(lastWeek),
      getDemosCompletedToday(lastWeek),
      getCallsForDay(lastWeek)
    ]);
    
    comparison = {
      demosBooked: demosBookedToday.length - demosBookedLastWeek.length,
      demosCompleted: demosCompletedToday.length - demosCompletedLastWeek.length,
      calls: callsToday.length - callsLastWeek.length
    };
  }
  
  const metrics = analyzeCallMetrics(callsToday);
  const leaderboard = buildLeaderboard(demosBookedToday, demosCompletedToday, callsToday, owners);
  
  // Calculate conversion rate
  const conversionRate = callsToday.length > 0 
    ? ((demosBookedToday.length / callsToday.length) * 100).toFixed(1)
    : 0;
  
  return {
    date: today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    totals: {
      demosBooked: demosBookedToday.length,
      demosCompleted: demosCompletedToday.length,
      calls: callsToday.length,
      timeOnPhone: metrics.totalMinutes,
      conversionRate
    },
    metrics,
    leaderboard,
    comparison
  };
}

// Format the digest as a Slack message
function formatDigestMessage(digest) {
  const { date, totals, metrics, leaderboard, comparison } = digest;
  
  let message = `📊 *DAILY SALES DIGEST*\n_${date}_\n\n`;
  
  // Key Metrics
  message += `*📈 KEY METRICS*\n`;
  message += `> • Demos Booked: *${totals.demosBooked}*`;
  if (comparison && comparison.demosBooked !== 0) {
    const arrow = comparison.demosBooked > 0 ? '📈' : '📉';
    message += ` ${arrow} ${comparison.demosBooked > 0 ? '+' : ''}${comparison.demosBooked} vs last week`;
  }
  message += `\n> • Demos Completed: *${totals.demosCompleted}*`;
  if (comparison && comparison.demosCompleted !== 0) {
    const arrow = comparison.demosCompleted > 0 ? '📈' : '📉';
    message += ` ${arrow} ${comparison.demosCompleted > 0 ? '+' : ''}${comparison.demosCompleted} vs last week`;
  }
  message += `\n> • Total Calls: *${totals.calls}*`;
  if (comparison && comparison.calls !== 0) {
    const arrow = comparison.calls > 0 ? '📈' : '📉';
    message += ` ${arrow} ${comparison.calls > 0 ? '+' : ''}${comparison.calls} vs last week`;
  }
  message += `\n> • Time on Phone: *${totals.timeOnPhone} mins*\n`;
  message += `> • Conversion Rate: *${totals.conversionRate}%*\n\n`;
  
  // Additional Insights
  if (metrics.averageDuration > 0) {
    message += `*💡 INSIGHTS*\n`;
    message += `> • Average Call: *${metrics.averageDuration} mins*\n`;
    
    if (metrics.longestCall) {
      message += `> • Longest Call: *${metrics.longestCall.duration} mins* by ${metrics.longestCall.user} with ${metrics.longestCall.contact}\n`;
    }
    
    if (metrics.mostActiveHour) {
      message += `> • Most Active Hour: *${metrics.mostActiveHour.formatted}* (${metrics.mostActiveHour.count} calls)\n`;
    }
    message += `\n`;
  }
  
  // Leaderboard
  // Leaderboard
message += `*🏆 DAILY LEADERBOARD*\n`;
message += `_5 pts per demo completed • 3 pts per demo booked • 2 pts per conversation • 1 pt per connection_\n\n`;

if (leaderboard.length === 0) {
  message += `> _No activity today_\n`;
} else {
  leaderboard.forEach((rep, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `   ${index + 1}.`;
    message += `> ${medal} *${rep.name}* - ${rep.score} pts\n`;
    message += `>       ${rep.conversations} conversations • ${rep.connections} connections • ${rep.demosBooked} demos booked • ${rep.demosCompleted} demos completed\n`;
  });
}
  
  return message;
}

module.exports = {
  generateDailyDigest,
  formatDigestMessage
};