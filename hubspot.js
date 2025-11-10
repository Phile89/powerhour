const axios = require('axios');

async function getDealsCreatedInTimeRange(startTime, endTime) {
  try {
    const startTimeMs = new Date(startTime).getTime();
    const endTimeMs = new Date(endTime).getTime();
    
    const response = await axios.post('https://api.hubapi.com/crm/v3/objects/deals/search', {
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'dealstage',
              operator: 'EQ',
              value: '098183b8-daf7-4145-b7af-17dd19c077f9'  // UUID for Demo Scheduled
            },
            {
              propertyName: 'createdate',
              operator: 'GTE',
              value: startTimeMs
            },
            {
              propertyName: 'createdate',
              operator: 'LTE',
              value: endTimeMs
            }
          ]
        }
      ],
      properties: ['dealname', 'createdate', 'hubspot_owner_id', 'dealstage'],
      limit: 100
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('HubSpot found', response.data.results.length, 'deals');
    
    return response.data.results;
  } catch (error) {
    console.error('HubSpot API Error:', error.response?.data || error.message);
    return [];
  }
}

async function getCallsInTimeRange(startTime, endTime) {
  try {
    const response = await axios.post('https://api.hubapi.com/crm/v3/objects/calls/search', {
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'hs_createdate',
              operator: 'GTE',
              value: startTime
            },
            {
              propertyName: 'hs_createdate',
              operator: 'LTE',
              value: endTime
            },
            {
              propertyName: 'hs_call_duration',
              operator: 'GTE',
              value: '120000' // 2 minutes in milliseconds
            }
          ]
        }
      ],
      properties: ['hs_call_title', 'hs_createdate', 'hubspot_owner_id', 'hs_call_duration'],
      limit: 100
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    
    return response.data.results;
  } catch (error) {
    console.error('HubSpot Calls API Error:', error.response?.data || error.message);
    return [];
  }
}

module.exports = { getDealsCreatedInTimeRange, getCallsInTimeRange };