const { google } = require('googleapis');

// Initialize Google Sheets client
function getGoogleSheetsClient() {
  let credentials;
  
  // In production (Render), credentials come from environment variable
  if (process.env.GOOGLE_CREDENTIALS) {
    credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  } else {
    // In development, read from file
    credentials = require('./google-credentials.json');
  }
  
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  
  return google.sheets({ version: 'v4', auth });
}

async function logPowerHourResults(sessionData) {
  try {
    const sheets = getGoogleSheetsClient();
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    
    if (!spreadsheetId) {
      console.error('GOOGLE_SHEET_ID not set');
      return;
    }
    
    // Calculate totals
    let totalConnections = 0;
    let totalConversations = 0;
    let totalDemos = 0;
    let winner = null;
    let winnerScore = 0;
    
    const repNames = Object.keys(sessionData.repStats);
    if (repNames.length > 0) {
      const leaderboard = repNames.map(name => {
        const stats = sessionData.repStats[name];
        const connectionPoints = (stats.connections || 0) * 1;
        const conversationPoints = (stats.conversations || 0) * 2;
        const demoPoints = (stats.demos || 0) * 5;
        
        totalConnections += stats.connections || 0;
        totalConversations += stats.conversations || 0;
        totalDemos += stats.demos || 0;
        
        return { 
          name, 
          score: connectionPoints + conversationPoints + demoPoints,
          connections: stats.connections || 0,
          conversations: stats.conversations || 0,
          demos: stats.demos || 0
        };
      }).sort((a, b) => b.score - a.score);
      
      winner = leaderboard[0].name;
      winnerScore = leaderboard[0].score;
    }
    
    const date = new Date().toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric', 
      year: 'numeric' 
    });
    
    const teamGoalMet = sessionData.teamDemos >= 12 ? 'Yes' : 'No';
    
    // Append row to sheet
    const values = [[
      date,
      sessionData.duration,
      totalConnections,
      totalConversations,
      totalDemos,
      winner || 'N/A',
      winnerScore,
      teamGoalMet
    ]];
    
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Sheet1!A:H',
      valueInputOption: 'USER_ENTERED',
      resource: { values }
    });
    
    console.log('✅ Power Hour results logged to Google Sheets');
    
  } catch (error) {
    console.error('Error logging to Google Sheets:', error.message);
  }
}

module.exports = {
  logPowerHourResults
};