const fs = require('fs');
const axios = require('axios');
const path = require('path');

(async () => {
  try {
    const token = fs.readFileSync(path.join(__dirname, 'lawmatics.token'), 'utf-8').trim();

    const res = await axios.get('https://api.lawmatics.com/v1/prospects', {
      headers: {
        Authorization: `Bearer ${token}`,
      }
    });

    console.log('✅ Token working. Response:', res.data);
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;

    console.error('❌ Token test failed:');
    console.error('Status:', status);
    console.error('Response:', data);
  }
})();
