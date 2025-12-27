require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const { google } = require('googleapis');
const fs = require('fs');

async function testDriveAuth() {
  try {
    console.log('🔐 Testing Google Drive authentication...');
    
    // Check if credentials file exists
    const credentialsPath = require('path').join(__dirname, 'lawmatics-uspto-automation-a21b7a12b1d6.json');
    if (!fs.existsSync(credentialsPath)) {
      console.error('❌ credentials.json file not found!');
      return;
    }
    
    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    console.log('✅ credentials.json found and parsed');
    
    const auth = new google.auth.GoogleAuth({
      keyFile: credentialsPath,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    
    const authClient = await auth.getClient();
    console.log('✅ Google Auth client created successfully');
    
    const drive = google.drive({ version: 'v3', auth: authClient });
    
    // Test listing files to verify authentication
    const res = await drive.files.list({
      pageSize: 5,
      fields: 'nextPageToken, files(id, name)',
    });
    
    console.log('✅ Authentication successful! Files found:', res.data.files.length);
    console.log('📁 Sample files:', res.data.files.map(f => f.name));
    
  } catch (error) {
    console.error('❌ Authentication failed:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
  }
}

testDriveAuth();