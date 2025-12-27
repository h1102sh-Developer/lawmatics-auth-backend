const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// ========================
// 🔐 Google OAuth Setup
// ========================
const { getOAuthCredentials, getTokenCredentials } = require('./config/googleAuth');
const CREDENTIALS = getOAuthCredentials();
const { client_secret, client_id, redirect_uris } = CREDENTIALS.web;

const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

// ========================
// 🔑 Load token from environment or file
// ========================
let tokenData = null;
let isAuthenticated = false;

try {
  tokenData = getTokenCredentials();
  if (tokenData) {
    oAuth2Client.setCredentials(tokenData);
    isAuthenticated = true;
    console.log("✅ Google Drive token loaded successfully");
  } else {
    console.log("⚠️  No Google Drive token available - uploads will be skipped");
  }
} catch (error) {
  console.log("⚠️  Could not load Google Drive token - uploads will be skipped:", error.message);
}

// Auto-refresh: save updated access tokens
oAuth2Client.on('tokens', (tokens) => {
  if (tokens.refresh_token || tokens.access_token) {
    console.log("🔄 Token refreshed");
    
    // For local development, write to file
    if (process.env.NODE_ENV !== 'production' && fs.existsSync) {
      const TOKEN_PATH = path.join(__dirname, 'token.json');
      try {
        const currentToken = fs.existsSync(TOKEN_PATH) 
          ? JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'))
          : {};
        
        fs.writeFileSync(TOKEN_PATH, JSON.stringify({
          ...currentToken,
          ...tokens
        }, null, 2));
        console.log("💾 Token saved to token.json");
      } catch (error) {
        console.log("📝 Could not save token to file (this is normal in production)");
      }
    }
  }
});

// ========================
// 📂 Upload Helper
// ========================
async function uploadToDrive(filePath, fileName, folderId) {
  // If no token is available, skip Google Drive upload
  if (!isAuthenticated) {
    console.log("⏭️  Skipping Google Drive upload - no authentication token available");
    return { id: null, webViewLink: null, skipped: true };
  }

  console.log("📂 Uploading to Google Drive:", {
    filePath,
    fileExists: fs.existsSync(filePath),
    fileName,
    folderId
  });

  const drive = google.drive({ version: 'v3', auth: oAuth2Client });

  const fileMetadata = {
    name: fileName,
    parents: [folderId],
  };

  try {
    const media = { body: fs.createReadStream(filePath) };

    const res = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id, webViewLink',
    });

    console.log("✅ File uploaded successfully to Google Drive");
    return res.data;
  } catch (err) {
    console.error("🚨 Drive API error:", err.response?.data || err.message);
    throw err;
  }
}

module.exports = { uploadToDrive, oAuth2Client, isAuthenticated };
