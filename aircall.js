const axios = require('axios');

async function getCallsInTimeRange(startTime, endTime) {
  try {
    // Convert timestamps to seconds for Aircall
    const fromTimestamp = Math.floor(new Date(startTime).getTime() / 1000);
    const toTimestamp = Math.floor(new Date(endTime).getTime() / 1000);
    
    // Aircall uses Basic Auth with API ID as username and Token as password
    const auth = Buffer.from(`${process.env.AIRCALL_API_ID}:${process.env.AIRCALL_API_TOKEN}`).toString('base64');
    
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
    
    // Filter for calls longer than 2 minutes (120 seconds)
    const filteredCalls = response.data.calls.filter(call => call.duration >= 120);
    
    return filteredCalls;
  } catch (error) {
    console.error('Aircall API Error:', error.response?.data || error.message);
    return [];
  }
}

module.exports = { getCallsInTimeRange };