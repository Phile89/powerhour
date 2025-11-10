const axios = require('axios');

// Cache owners to avoid repeated API calls
let ownersCache = null;

async function getOwners() {
  if (ownersCache) return ownersCache;
  
  try {
    const response = await axios.get('https://api.hubapi.com/crm/v3/owners', {
      headers: {
        'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`
      }
    });
    
    // Create a map of owner ID to name
    ownersCache = {};
    response.data.results.forEach(owner => {
      ownersCache[owner.id] = `${owner.firstName} ${owner.lastName}`;
    });
    
    console.log('Loaded', Object.keys(ownersCache).length, 'owners');
    return ownersCache;
  } catch (error) {
    console.error('Error fetching owners:', error.message);
    return {};
  }
}

module.exports = { getOwners };